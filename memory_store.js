#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function nowIso() {
  return new Date().toISOString();
}

function toIsoFromDays(days) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch (_e) {
    return fallback;
  }
}

function truncate(text, maxChars) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...(truncated)`;
}

function normalizeStringArray(input, maxItems = 10) {
  if (!Array.isArray(input)) return [];
  return input
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

class MemoryStore {
  constructor(options = {}) {
    this.enabled = String(options.enabled || 'false') === 'true';
    this.backend = options.backend || 'qdrant';
    this.project = options.project || 'codex_worker';

    this.qdrantUrl = (options.qdrantUrl || 'http://qdrant:6333').replace(/\/$/, '');
    this.collection = options.collection || 'codex_memory';

    this.embeddingApiKey = (options.embeddingApiKey || '').trim();
    this.embeddingModel = options.embeddingModel || 'text-embedding-3-small';
    this.embeddingBaseUrl = (options.embeddingBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    this.embeddingDim = Number(options.embeddingDim || 1536);

    this.topK = Number(options.topK || 5);
    this.scoreThreshold = Number(options.scoreThreshold || 0.35);
    this.shortTtlDays = Number(options.shortTtlDays || 14);

    this.fallbackFile = options.fallbackFile || '/home/codex/.codex/memory/fallback.jsonl';
    this.maxFallbackItems = Number(options.maxFallbackItems || 1000);

    this.initialized = false;
    this.mode = this.enabled ? this.backend : 'disabled';
  }

  async init(log = () => {}) {
    if (!this.enabled) {
      log('memory disabled');
      this.mode = 'disabled';
      this.initialized = true;
      return;
    }

    if (!this.embeddingApiKey) {
      log('memory enabled but OPENAI_API_KEY missing; fallback to keyword mode');
      this.mode = 'fallback';
      await this.ensureFallbackFile();
      this.initialized = true;
      return;
    }

    try {
      await this.ensureCollection();
      this.mode = 'qdrant';
      this.initialized = true;
      log(`memory initialized in qdrant mode, collection=${this.collection}`);
    } catch (err) {
      log(`memory qdrant init failed: ${err.message}; fallback to keyword mode`);
      this.mode = 'fallback';
      await this.ensureFallbackFile();
      this.initialized = true;
    }
  }

  async ensureCollection() {
    const getResp = await fetch(`${this.qdrantUrl}/collections/${encodeURIComponent(this.collection)}`);
    if (getResp.ok) return;

    if (getResp.status !== 404) {
      const body = await getResp.text();
      throw new Error(`qdrant get collection failed: ${getResp.status} ${body}`);
    }

    const createResp = await fetch(`${this.qdrantUrl}/collections/${encodeURIComponent(this.collection)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vectors: {
          size: this.embeddingDim,
          distance: 'Cosine',
        },
      }),
    });

    if (!createResp.ok) {
      const body = await createResp.text();
      throw new Error(`qdrant create collection failed: ${createResp.status} ${body}`);
    }
  }

  async ensureFallbackFile() {
    const dir = path.dirname(this.fallbackFile);
    await fs.promises.mkdir(dir, { recursive: true });
    try {
      await fs.promises.access(this.fallbackFile, fs.constants.F_OK);
    } catch (_e) {
      await fs.promises.writeFile(this.fallbackFile, '');
    }
  }

  async embed(text) {
    const resp = await fetch(`${this.embeddingBaseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.embeddingApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.embeddingModel,
        input: text,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`embedding failed: ${resp.status} ${body}`);
    }

    const json = await resp.json();
    const v = json?.data?.[0]?.embedding;
    if (!Array.isArray(v) || v.length === 0) {
      throw new Error('embedding response missing vector');
    }
    return v;
  }

  async retrieve(query, opts = {}) {
    if (!this.initialized) {
      throw new Error('memory not initialized');
    }

    if (this.mode === 'disabled') return [];

    const project = opts.project || this.project;
    const limit = Number(opts.limit || this.topK);
    const channel = String(opts.channel || '').trim();
    const username = String(opts.username || '').trim();
    const source = String(opts.source || '').trim();

    if (this.mode === 'fallback') {
      return this.retrieveFallback(query, { project, limit, channel, username, source });
    }

    const vector = await this.embed(query);
    const mustFilters = [
      {
        key: 'project',
        match: { value: project },
      },
    ];
    if (channel) {
      mustFilters.push({
        key: 'channel',
        match: { value: channel },
      });
    }
    if (username) {
      mustFilters.push({
        key: 'username',
        match: { value: username },
      });
    }
    if (source) {
      mustFilters.push({
        key: 'source',
        match: { value: source },
      });
    }

    const searchBody = {
      vector,
      limit,
      with_payload: true,
      filter: {
        must: mustFilters,
      },
    };

    const resp = await fetch(`${this.qdrantUrl}/collections/${encodeURIComponent(this.collection)}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(searchBody),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`qdrant search failed: ${resp.status} ${body}`);
    }

    const json = await resp.json();
    const result = Array.isArray(json?.result) ? json.result : [];

    const now = Date.now();
    return result
      .filter((r) => typeof r?.score === 'number' && r.score >= this.scoreThreshold)
      .map((r) => {
        const p = r.payload || {};
        return {
          id: String(r.id || p.id || ''),
          score: r.score,
          summary: String(p.summary || ''),
          text: String(p.text || ''),
          decisions: Array.isArray(p.decisions) ? p.decisions : [],
          facts: Array.isArray(p.facts) ? p.facts : [],
          tags: Array.isArray(p.tags) ? p.tags : [],
          metadata: p.metadata && typeof p.metadata === 'object' ? p.metadata : {},
          created_at: p.created_at || '',
          expires_at: p.expires_at || '',
        };
      })
      .filter((m) => !m.expires_at || new Date(m.expires_at).getTime() > now);
  }

  async remember(entry, opts = {}) {
    if (!this.initialized || this.mode === 'disabled') return;

    const project = opts.project || this.project;
    const createdAt = nowIso();
    const scope = entry.scope || 'short';
    const expiresAt = scope === 'short' ? toIsoFromDays(this.shortTtlDays) : '';

    const summary = truncate(entry.summary || '', 500);
    const text = truncate(entry.text || '', 4000);
    const decisions = Array.isArray(entry.decisions) ? entry.decisions.slice(0, 8) : [];
    const facts = Array.isArray(entry.facts) ? entry.facts.slice(0, 12) : [];
    const tags = normalizeStringArray(entry.tags, 12);
    const metadata = entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {};

    const payload = {
      id: entry.id || crypto.randomUUID(),
      project,
      scope,
      summary,
      text,
      decisions,
      facts,
      source: entry.source || '',
      channel: entry.channel || '',
      username: entry.username || '',
      tags,
      metadata,
      sensitivity: entry.sensitivity || 'normal',
      created_at: createdAt,
      updated_at: createdAt,
      expires_at: expiresAt,
    };

    if (payload.sensitivity === 'secret') {
      payload.text = '[REDACTED]';
    }

    if (this.mode === 'fallback') {
      await this.rememberFallback(payload);
      return;
    }

    const vector = await this.embed(`${summary}\n${payload.text}`);
    const body = {
      points: [
        {
          id: payload.id,
          vector,
          payload,
        },
      ],
    };

    const resp = await fetch(`${this.qdrantUrl}/collections/${encodeURIComponent(this.collection)}/points`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const respBody = await resp.text();
      throw new Error(`qdrant upsert failed: ${resp.status} ${respBody}`);
    }
  }

  async rememberFallback(payload) {
    await this.ensureFallbackFile();
    const line = JSON.stringify(payload) + '\n';
    await fs.promises.appendFile(this.fallbackFile, line, 'utf8');

    const content = await fs.promises.readFile(this.fallbackFile, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length <= this.maxFallbackItems) return;

    const trimmed = lines.slice(lines.length - this.maxFallbackItems).join('\n') + '\n';
    await fs.promises.writeFile(this.fallbackFile, trimmed, 'utf8');
  }

  async retrieveFallback(query, opts = {}) {
    await this.ensureFallbackFile();

    const project = opts.project || this.project;
    const limit = Number(opts.limit || this.topK);
    const channel = String(opts.channel || '').trim();
    const username = String(opts.username || '').trim();
    const source = String(opts.source || '').trim();

    const content = await fs.promises.readFile(this.fallbackFile, 'utf8');
    const items = content.split('\n').filter(Boolean).map((line) => safeJsonParse(line, null)).filter(Boolean);
    const now = Date.now();

    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);

    const scored = items
      .filter((x) => x.project === project)
      .filter((x) => !channel || String(x.channel || '') === channel)
      .filter((x) => !username || String(x.username || '') === username)
      .filter((x) => !source || String(x.source || '') === source)
      .filter((x) => !x.expires_at || new Date(x.expires_at).getTime() > now)
      .map((x) => {
        const target = `${x.summary || ''} ${x.text || ''}`.toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (target.includes(t)) score += 1;
        }
        return { ...x, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => ({
        id: String(x.id || ''),
        score: x.score,
        summary: String(x.summary || ''),
        text: String(x.text || ''),
        decisions: Array.isArray(x.decisions) ? x.decisions : [],
        facts: Array.isArray(x.facts) ? x.facts : [],
        tags: Array.isArray(x.tags) ? x.tags : [],
        metadata: x.metadata && typeof x.metadata === 'object' ? x.metadata : {},
        created_at: x.created_at || '',
        expires_at: x.expires_at || '',
      }));

    return scored;
  }

  async listRecent(opts = {}) {
    if (!this.initialized) {
      throw new Error('memory not initialized');
    }
    if (this.mode === 'disabled') return [];

    const project = opts.project || this.project;
    const limit = Math.max(1, Math.min(Number(opts.limit || 50), 200));

    if (this.mode === 'fallback') {
      await this.ensureFallbackFile();
      const content = await fs.promises.readFile(this.fallbackFile, 'utf8');
      const items = content
        .split('\n')
        .filter(Boolean)
        .map((line) => safeJsonParse(line, null))
        .filter(Boolean)
        .filter((x) => x.project === project)
        .slice(-limit)
        .reverse()
        .map((x) => ({
          id: String(x.id || ''),
          scope: String(x.scope || ''),
          summary: String(x.summary || ''),
          text: String(x.text || ''),
          source: String(x.source || ''),
          channel: String(x.channel || ''),
          username: String(x.username || ''),
          tags: Array.isArray(x.tags) ? x.tags : [],
          metadata: x.metadata && typeof x.metadata === 'object' ? x.metadata : {},
          created_at: x.created_at || '',
          expires_at: x.expires_at || '',
        }));
      return items;
    }

    const body = {
      limit,
      with_payload: true,
      with_vector: false,
      filter: {
        must: [
          {
            key: 'project',
            match: { value: project },
          },
        ],
      },
    };

    const resp = await fetch(`${this.qdrantUrl}/collections/${encodeURIComponent(this.collection)}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`qdrant list recent failed: ${resp.status} ${text}`);
    }
    const json = await resp.json();
    const points = Array.isArray(json?.result?.points) ? json.result.points : [];
    return points
      .map((p) => {
        const payload = p.payload || {};
        return {
          id: String(p.id || payload.id || ''),
          scope: String(payload.scope || ''),
          summary: String(payload.summary || ''),
          text: String(payload.text || ''),
          source: String(payload.source || ''),
          channel: String(payload.channel || ''),
          username: String(payload.username || ''),
          tags: Array.isArray(payload.tags) ? payload.tags : [],
          metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
          created_at: payload.created_at || '',
          expires_at: payload.expires_at || '',
        };
      })
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit);
  }
}

function buildMemoryContext(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return '';

  const lines = ['[Memory Context]'];
  memories.forEach((m, idx) => {
    lines.push(`${idx + 1}. id=${m.id} score=${typeof m.score === 'number' ? m.score.toFixed(3) : m.score}`);
    if (m.summary) lines.push(`summary: ${m.summary}`);
    if (Array.isArray(m.decisions) && m.decisions.length > 0) {
      lines.push(`decisions: ${m.decisions.join(' | ')}`);
    }
    if (Array.isArray(m.facts) && m.facts.length > 0) {
      lines.push(`facts: ${m.facts.join(' | ')}`);
    }
    if (Array.isArray(m.tags) && m.tags.length > 0) {
      lines.push(`tags: ${m.tags.join(', ')}`);
    }
  });
  return lines.join('\n');
}

function buildMemoryEntry(messageText, outputText, options = {}) {
  const cleanOutput = String(outputText || '').trim();
  const cleanMsg = String(messageText || '').trim();
  const sourceTag = String(options.sourceTag || '').trim();
  const tags = normalizeStringArray(options.tags || [], 12);
  const metadata = options.metadata && typeof options.metadata === 'object' ? options.metadata : {};

  const compactOutput = cleanOutput.replace(/\s+/g, ' ').slice(0, 280);
  const prefix = sourceTag ? `[${sourceTag}] ` : '';
  const summary = truncate(`${prefix}Q: ${cleanMsg}\nA: ${compactOutput}`, 500);

  const lines = cleanOutput
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

  const facts = lines
    .filter((x) => /^[-*•]\s+/.test(x) || /^(fact|事實|資訊|重點)[:：]/i.test(x))
    .map((x) => x.replace(/^[-*•]\s+/, ''))
    .slice(0, 8);

  const decisions = lines
    .filter((x) => /(建議|下一步|決策|action|todo)/i.test(x))
    .slice(0, 6);

  return {
    scope: options.scope || 'short',
    summary,
    text: `User: ${cleanMsg}\nAssistant: ${truncate(cleanOutput, 2800)}`,
    decisions,
    facts,
    tags,
    metadata,
    sensitivity: /token|password|passwd|secret|apikey|api_key/i.test(`${cleanMsg} ${cleanOutput}`) ? 'secret' : 'normal',
  };
}

module.exports = {
  MemoryStore,
  buildMemoryContext,
  buildMemoryEntry,
};

'use strict';

const { log } = require('../logger');

class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 30000; // 30 seconds
    
    this.failures = 0;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.lastFailureTime = null;
  }

  async run(fn, fallback = null) {
    if (this.state === 'OPEN') {
      const now = Date.now();
      if (now - this.lastFailureTime > this.resetTimeout) {
        this.state = 'HALF_OPEN';
        log(`Circuit breaker [${this.name}] is HALF_OPEN, probing...`);
      } else {
        log(`Circuit breaker [${this.name}] is OPEN, blocking request.`);
        if (fallback) return fallback();
        throw new Error(`circuit_breaker_open: ${this.name}`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      log(`Circuit breaker [${this.name}] caught error: ${err.message}`);
      if (fallback) return fallback();
      throw err;
    }
  }

  onSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
    this.lastFailureTime = null;
  }

  onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      log(`Circuit breaker [${this.name}] is now OPEN!`);
    }
  }
}

module.exports = {
  CircuitBreaker,
};

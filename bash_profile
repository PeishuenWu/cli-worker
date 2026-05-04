# --- Codex-CLI Auto-Screen Start (Multi-UTF8) ---
#
# 目的：
# - SSH 登入時自動進入 screen，並啟動/接回 codex-cli
# - 強制開啟 UTF-8 模式避免亂碼
# - 提供三個固定的 screen 會話可選擇
#

# 0) 先確保當前 Shell 環境變數正確
export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"

# 1) 確保只在 SSH 登入且不在 Screen 內時觸發
if [ -z "$STY" ] && [ -n "$SSH_TTY" ]; then
    # 2) 確認 screen 指令存在
    if ! command -v screen >/dev/null 2>&1; then
        echo "找不到 screen，請先安裝：sudo apt-get install screen"
        return 0 2>/dev/null || exit 0
    fi

    # 3) 固定會話名稱
    SESSION_1="codex"
    SESSION_2="codex2"
    SESSION_3="codex3"

    # 取得目前 screen 狀態函數
    session_state() {
        local name="$1"
        local ls_output
        ls_output="$(screen -ls 2>/dev/null)"
        if ! printf '%s\n' "$ls_output" | grep -qE "\\.${name}[[:space:]]"; then
            printf '%s' "absent"
        elif printf '%s\n' "$ls_output" | grep -qE "\\.${name}[[:space:]].*\\(Attached\\)"; then
            printf '%s' "attached"
        else
            printf '%s' "detached"
        fi
    }

    S1_STATE="$(session_state "$SESSION_1")"
    S2_STATE="$(session_state "$SESSION_2")"
    S3_STATE="$(session_state "$SESSION_3")"

    # 3.2) 自動預設選擇
    DEFAULT_CHOICE="1"
    if [ "$S1_STATE" = "attached" ]; then
        if [ "$S2_STATE" != "attached" ]; then
            DEFAULT_CHOICE="2"
        elif [ "$S3_STATE" != "attached" ]; then
            DEFAULT_CHOICE="3"
        fi
    fi

    echo "------------------------------------------------"
    echo "  Codex-CLI Screen Manager (UTF-8 Mode)"
    echo "------------------------------------------------"
    echo "  1) ${SESSION_1} [${S1_STATE}]"
    echo "  2) ${SESSION_2} [${S2_STATE}]"
    echo "  3) ${SESSION_3} [${S3_STATE}]"
    echo "  4) Bash Shell (跳過 Screen)"
    echo "------------------------------------------------"

    # 4) 讀取選擇（8秒超時）
    CHOICE=""
    read -r -t 8 -p "請選擇 [1-4] (預設 ${DEFAULT_CHOICE}): " CHOICE || true
    [ -z "$CHOICE" ] && CHOICE="$DEFAULT_CHOICE"

    case "$CHOICE" in
        4) echo "進入 Bash Shell..."; cd ~/workspace 2>/dev/null; return 0 2>/dev/null || exit 0 ;;
        3|"$SESSION_3") SESSION_NAME="$SESSION_3" ;;
        2|"$SESSION_2") SESSION_NAME="$SESSION_2" ;;
        *) SESSION_NAME="$SESSION_1" ;;
    esac

    # 切換工作目錄
    cd ~/workspace || cd ~ || true

    # 5) 執行或重連 Screen (加入 -U 參數強制 UTF-8)
    if screen -ls | grep -qE "\.${SESSION_NAME}[[:space:]]"; then
        echo "正在連接至會話：$SESSION_NAME ..."
        CURRENT_STATE="$(session_state "$SESSION_NAME")"
        
        # 如果已被附著且沒設定排他模式，使用 -x (Multi-display)
        if [ "$CURRENT_STATE" = "attached" ] && [ -z "$CODEX_SCREEN_EXCLUSIVE" ]; then
            exec screen -U -x "$SESSION_NAME"
        else
            # -dr 會踢掉遺留的虛擬附著並重新進入
            exec screen -U -dr "$SESSION_NAME"
        fi
    else
        echo "建立新 UTF-8 會話並啟動 codex-cli..."
        # 在啟動時將環境變數注入子 Shell 確保不亂碼
        exec screen -U -S "$SESSION_NAME" bash -c "
            export LANG='en_US.UTF-8';
            export LC_ALL='en_US.UTF-8';
            while true; do
                echo '--- [$(date +%H:%M:%S)] 啟動 codex-cli ---';
                codex;
                echo '程式已停止，5秒後自動重啟... (Ctrl+C 可停止)';
                sleep 5;
            done;
            exec bash"
    fi
fi
# --- End of Codex-CLI Auto-Screen ---

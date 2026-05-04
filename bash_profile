# --- Codex-CLI Auto-Screen Start (Multi) ---
#
# 目的：
# - SSH 登入時自動進入 screen，並啟動/接回 codex-cli
# - 提供兩個固定的 screen 會話可選擇（例如兩個專案/兩個工作區）
#

# 1) 確保只在 SSH 登入且不在 Screen 內時觸發
if [ -z "$STY" ] && [ -n "$SSH_TTY" ]; then
    # 2) 確認 screen 指令存在（避免卡住）
    if ! command -v screen >/dev/null 2>&1; then
        echo "找不到 screen，請先安裝：sudo apt-get install screen"
        return 0 2>/dev/null || exit 0
    fi

    # 3) 三個固定會話名稱
    SESSION_1="codex"
    SESSION_2="codex2"
    SESSION_3="codex3"

    # 3.1) 取得目前 screen 狀態（absent / detached / attached）
    SCREEN_LS="$(screen -ls 2>/dev/null || true)"
    session_state() {
        # usage: session_state <name>
        # prints: absent|detached|attached|present
        local name="$1"
        if ! printf '%s\n' "$SCREEN_LS" | grep -qE "\\.${name}[[:space:]]"; then
            printf '%s' "absent"
            return 0
        fi
        if printf '%s\n' "$SCREEN_LS" | grep -qE "\\.${name}[[:space:]].*\\(Attached\\)"; then
            printf '%s' "attached"
            return 0
        fi
        if printf '%s\n' "$SCREEN_LS" | grep -qE "\\.${name}[[:space:]].*\\(Detached\\)"; then
            printf '%s' "detached"
            return 0
        fi
        printf '%s' "present"
    }

    S1_STATE="$(session_state "$SESSION_1")"
    S2_STATE="$(session_state "$SESSION_2")"
    S3_STATE="$(session_state "$SESSION_3")"

    # 3.2) 預設選擇：若預設會踢到「已附著」的會話，改預設另一道
    DEFAULT_CHOICE="1"
    if [ "$S1_STATE" = "attached" ]; then
        if [ "$S2_STATE" != "attached" ]; then
            DEFAULT_CHOICE="2"
        elif [ "$S3_STATE" != "attached" ]; then
            DEFAULT_CHOICE="3"
        fi
    fi

    echo
    echo "請選擇要進入的模式或會話："
    echo "  1) ${SESSION_1} (${S1_STATE})"
    echo "  2) ${SESSION_2} (${S2_STATE})"
    echo "  3) ${SESSION_3} (${S3_STATE})"
    echo "  4) Bash Shell (不使用 Screen)"
    echo

    # 4) 讀取選擇（有 TTY 才會進到這段，因此可互動）
    #    - 8 秒未輸入則採用預設
    CHOICE=""
    read -r -t 8 -p "選擇 [1-4]（預設 ${DEFAULT_CHOICE}）: " CHOICE || true
    if [ -z "$CHOICE" ]; then
        CHOICE="$DEFAULT_CHOICE"
    fi

    case "$CHOICE" in
        4) echo "進入 Bash Shell..."; cd ~/workspace; return 0 2>/dev/null || exit 0 ;;
        3|"$SESSION_3") SESSION_NAME="$SESSION_3" ;;
        2|"$SESSION_2") SESSION_NAME="$SESSION_2" ;;
        1|"$SESSION_1") SESSION_NAME="$SESSION_1" ;;
        *) echo "輸入無效，使用預設：$DEFAULT_CHOICE"; 
           [ "$DEFAULT_CHOICE" = "1" ] && SESSION_NAME="$SESSION_1"
           [ "$DEFAULT_CHOICE" = "2" ] && SESSION_NAME="$SESSION_2"
           [ "$DEFAULT_CHOICE" = "3" ] && SESSION_NAME="$SESSION_3"
           ;;
    esac

    # 自動進入 workspace
    cd ~/workspace || true

    # 5) 若已有會話則接回，否則建立新會話並啟動 codex-cli
    #    注意：
    #    - 之前用 `screen -dr` 會把已附著的連線踢掉
    #    - 這裡改成：已附著時預設用 `screen -x`（共用，不踢人）
    #      如要強制踢掉舊連線再接回，可在環境變數設定：CODEX_SCREEN_EXCLUSIVE=1
    if screen -ls | grep -qE "\.${SESSION_NAME}[[:space:]]"; then
        echo "偵測到運行中的會話（$SESSION_NAME），正在連接..."
        CURRENT_STATE="$(session_state "$SESSION_NAME")"
        if [ "$CURRENT_STATE" = "attached" ] && [ -z "$CODEX_SCREEN_EXCLUSIVE" ]; then
            screen -x "$SESSION_NAME"
        else
            # -d -r 會踢掉之前的幻影/附著連線並進入（exclusive）
            screen -dr "$SESSION_NAME"
        fi
    else
        echo "正在建立新的 Screen 會話（$SESSION_NAME）並啟動 codex-cli..."
        # 建立新會話，並在其中執行一個無限循環，防止程式當掉就關閉會話
        screen -S "$SESSION_NAME" bash -c "
            while true; do
                echo '--- 啟動 codex-cli ---';
                codex;
                echo '程式已停止或崩潰，5秒後將自動重啟... (按 Ctrl+C 可停止循環)';
                sleep 5;
            done;
            exec bash"
    fi
fi

# --- End of Codex-CLI Auto-Screen (Multi) ---

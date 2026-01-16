#!/bin/bash
# ============================================
# LLM CLI Pipe - AI 세션 자동 캡처 및 처리
# ============================================
#
# AI CLI 도구(Claude, Codex 등)의 세션을 자동으로 캡처하고
# AI Pipeline을 통해 Obsidian 노트로 변환합니다.
#
# 설치:
#   source ~/ai-pipeline/scripts/llm-cli-pipe.sh
#   또는 aliases.sh를 통해 자동 로드
#
# 사용법:
#   claude-pipe              # Claude 세션 캡처 + 처리
#   codex-pipe               # Codex 세션 캡처 + 처리
#   llm-pipe <command>       # 임의의 CLI 캡처 (예: llm-pipe aider)
#   claude-pipe --no-process # 캡처만 (처리 안함)
#
# 설정:
#   config/settings.yaml의 pipeline.raw_logs_dir 사용
#

# === Configuration ===
AI_PIPELINE_HOME="${AI_PIPELINE_HOME:-$HOME/ai-pipeline}"
AI_PIPELINE_SCRIPTS="$AI_PIPELINE_HOME/scripts"

# Python 경로 (venv 우선)
_ai_get_python() {
    if [[ -f "$AI_PIPELINE_HOME/.venv/bin/python3" ]]; then
        echo "$AI_PIPELINE_HOME/.venv/bin/python3"
    else
        echo "python3"
    fi
}

# settings.yaml에서 raw_logs_dir 읽기
_ai_get_raw_logs_dir() {
    local python_cmd=$(_ai_get_python)
    local result=$("$python_cmd" -c "
import yaml
from pathlib import Path

config_files = [
    Path('$AI_PIPELINE_HOME/config/settings.local.yaml'),
    Path('$AI_PIPELINE_HOME/config/settings.yaml'),
    Path('$AI_PIPELINE_HOME/config/settings.example.yaml'),
]

for f in config_files:
    if f.exists():
        with open(f) as file:
            config = yaml.safe_load(file)
            raw_dir = config.get('pipeline', {}).get('raw_logs_dir', '~/.ai-pipeline/raw')
            print(Path(raw_dir).expanduser())
            break
" 2>/dev/null)

    # 실패시 기본값
    if [[ -z "$result" ]]; then
        result="$HOME/.ai-pipeline/raw"
    fi
    echo "$result"
}

# === ANSI 제어 문자 제거 ===
_ai_clean_log() {
    local log_file="$1"

    if [[ ! -f "$log_file" ]]; then
        return 1
    fi

    local temp_clean="${log_file}.clean"

    # ANSI/OSC 시퀀스 및 제어 문자 제거
    # - CSI 시퀀스: 색상, 커서 이동 등
    # - OSC 시퀀스: 윈도우 타이틀 등
    # - 특수 제어 문자: Backspace, Bell 등
    LC_ALL=C sed -E \
        -e 's/\x1b\[[0-9;]*[a-zA-Z]//g' \
        -e 's/\x1b\[\?([0-9;]*)[a-zA-Z]//g' \
        -e 's/\x1b\][0-9;]*\x07//g' \
        -e 's/\x1b[()][A-Z0-9]//g' \
        "$log_file" 2>/dev/null | \
        col -b 2>/dev/null | \
        LC_ALL=C sed -E \
        -e 's/[\x01-\x08\x0B\x0C\x0E-\x1F]//g' \
        -e 's/[\x1b[:space:]]*$//g' \
        > "$temp_clean" 2>/dev/null

    if [[ -s "$temp_clean" ]]; then
        mv "$temp_clean" "$log_file"
        return 0
    else
        rm -f "$temp_clean"
        return 1
    fi
}

# === 세션 처리 (processor.py 호출) ===
_ai_process_log() {
    local log_file="$1"
    local python_cmd=$(_ai_get_python)

    echo ""
    echo "Processing session log..."
    echo ""

    "$python_cmd" "$AI_PIPELINE_SCRIPTS/processor.py" "$log_file"
    return $?
}

# === Generic LLM Pipe Function ===
llm-pipe() {
    local cli_command="$1"
    shift

    if [[ -z "$cli_command" ]]; then
        echo "Usage: llm-pipe <command> [args...]"
        echo "Example: llm-pipe claude"
        echo "         llm-pipe codex --model gpt-4"
        echo "         llm-pipe aider"
        return 1
    fi

    local no_process=false
    local extra_args=()

    for arg in "$@"; do
        case "$arg" in
            --no-process)
                no_process=true
                ;;
            *)
                extra_args+=("$arg")
                ;;
        esac
    done

    # 설정에서 로그 디렉토리 가져오기
    local raw_logs_dir=$(_ai_get_raw_logs_dir)
    mkdir -p "$raw_logs_dir"

    # 로그 파일 경로
    local timestamp=$(date +"%Y%m%d_%H%M%S")
    local log_file="$raw_logs_dir/${cli_command}_${timestamp}.log"

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "AI Pipeline - Session Recording"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Command: $cli_command ${extra_args[*]}"
    echo "Log: $log_file"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    # script 명령어로 세션 캡처
    if [[ "$OSTYPE" == "darwin"* ]]; then
        script -q "$log_file" "$cli_command" "${extra_args[@]}"
    else
        script -q -c "$cli_command ${extra_args[*]}" "$log_file"
    fi

    local exit_code=$?

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Session Recording Ended"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # 로그 클리닝
    if _ai_clean_log "$log_file"; then
        echo "Log cleaned (ANSI codes removed)"
    fi

    # 파일 크기 확인
    if [[ -f "$log_file" ]]; then
        local file_size=$(wc -c < "$log_file" | tr -d ' ')
        echo "Log size: ${file_size} bytes"

        if [[ "$file_size" -lt 500 ]]; then
            echo "Session too short, skipping processing"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            return $exit_code
        fi

        # 처리 여부 확인
        if [[ "$no_process" == false ]]; then
            echo ""
            # Zsh/Bash 호환 read
            if [[ -n "$ZSH_VERSION" ]]; then
                read -k1 "confirm?Process this session? (y/N): "
            else
                read -n1 -p "Process this session? (y/N): " confirm
            fi
            echo ""

            if [[ "$confirm" =~ ^[Yy]$ ]]; then
                if _ai_process_log "$log_file"; then
                    echo ""
                    echo "Processing complete!"
                else
                    echo ""
                    echo "Processing failed. Log preserved: $log_file"
                fi
            else
                echo "Processing skipped"
            fi
        else
            echo "Processing skipped (--no-process)"
        fi
    fi

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    return $exit_code
}

# === Convenience Wrappers ===

# Claude CLI wrapper
claude-pipe() {
    llm-pipe claude "$@"
}

# Codex CLI wrapper
codex-pipe() {
    llm-pipe codex "$@"
}

# Aider wrapper (추가 지원)
aider-pipe() {
    llm-pipe aider "$@"
}

# === Help ===
llm-pipe-help() {
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "LLM CLI Pipe - AI Session Capture"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Commands:"
    echo "  claude-pipe [args]      Capture Claude CLI session"
    echo "  codex-pipe [args]       Capture Codex CLI session"
    echo "  aider-pipe [args]       Capture Aider session"
    echo "  llm-pipe <cmd> [args]   Capture any CLI session"
    echo ""
    echo "Options:"
    echo "  --no-process            Capture only, skip processing"
    echo ""
    echo "Examples:"
    echo "  claude-pipe                    # Start Claude with capture"
    echo "  codex-pipe --model gpt-4       # Start Codex with options"
    echo "  llm-pipe aider --model opus    # Capture Aider session"
    echo "  claude-pipe --no-process       # Capture without processing"
    echo ""
    echo "Log location: \$HOME/.ai-pipeline/raw/"
    echo "  (configurable via config/settings.yaml)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

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

_ai_clean_log() {
    local log_file="$1"

    if [[ ! -f "$log_file" ]]; then
        echo "Error: File not found - $log_file"
        return 1
    fi

    local temp_clean="${log_file}.clean"

    # 1. Perl: ANSI 코드, 깨진 제어 문자, 스마트 'r' 제거
    perl -pe '
        # [A] 표준 ANSI 및 공통 제어 코드 제거
        s/\x1b\[[0-9;]*[mK]//g;
        s/\x1b\[\?[0-9;]*[hl]//g;
        s/\x1b\[[0-9;]*[ABCDGHf]//g;
        s/\x1b\][^\x07\x1b]*(\x07|\x1b\\)//g;

        # [B] 깨진 제어 패턴(Artifacts) 제거
        s/r[0-9]+;[0-9]+r[A-Z]*//g;   # r1;43r 등
        s/[0-9]+;[0-9]+r[A-Z]*//g;    # 26;48rMM 등
        s/J<[0-9]+u//g;               # J<1u
        s/[0-9]+SrJ//g;               # 2SrJ

        # [C] 스마트 "r" 제거 (영어 단어 보호)
        s/(?<=[^a-zA-Z0-9])r$//g;     # 한글/특수문자 뒤의 r만 삭제
        s/rMr$//g;                    # 문장 끝 rMr 삭제
        s/[JM]+r+$//g;                # JMMMMr 등 삭제
        
        # [D] 나머지 청소
        s/\x1b\[//g; s/\x1b//g;
        s/╭─+╮//g; s/╰─+╯//g;         # 빈 박스 테두리 삭제
    ' "$log_file" | \

    # 2. 덮어쓰기 처리 (중복 문자 정돈)
    col -b | \

    # 3. 공백 정리 및 ★[최종 사용자 정의 필터링]★
    # 이 sed 블록 안에 삭제하고 싶은 패턴을 추가하세요. (/패턴/d)
    sed -E '
        s/[ \t]+$//;                # 줄 끝 공백 제거 (기본)

        # --- 커스텀 삭제 목록 ---
        /─{5,}/d;                   # "─"가 5개 이상 연속된 구분선 라인 삭제
        /esc to interrupt/d;        # "esc to interrupt" 포함 라인 삭제
        /orked for s/d;             # "orked for s" (Worked for s 찌꺼기) 포함 라인 삭제
        /se \/skills to list/d;     # 하단 스킬 목록 안내 삭제
        /for shortcuts/d;           # 단축키 안내 삭제
        /OpenAI Codex \(v/d;        # 상단 헤더 삭제
        # ---------------------
    ' | \

    # 4. 빈 줄 압축 (3줄 이상 빈 줄 -> 1줄)
    cat -s > "$temp_clean"

    # 5. 결과 적용
    if [[ -s "$temp_clean" ]]; then
        mv "$temp_clean" "$log_file"
        echo "Log cleaned: Custom filters applied."
        return 0
    else
        rm -f "$temp_clean"
        echo "Error: Output is empty."
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

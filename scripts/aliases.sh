#!/bin/bash
# AI Pipeline Shell Aliases
# ==========================
# 이 파일을 ~/.zshrc 또는 ~/.bashrc에 source 하세요:
#   source ~/ai-pipeline/scripts/aliases.sh

# 스크립트 경로
AI_PIPELINE_DIR="${AI_PIPELINE_DIR:-$HOME/ai-pipeline}"
AI_SCRIPTS="$AI_PIPELINE_DIR/scripts"

# Python 가상환경 활성화 (있으면)
_ai_python() {
    if [ -f "$AI_PIPELINE_DIR/.venv/bin/python" ]; then
        "$AI_PIPELINE_DIR/.venv/bin/python" "$@"
    else
        python3 "$@"
    fi
}

# === 핵심 명령어 ===

# quick: 빠른 메모
# 사용법: quick "kafka rebalancing 주의" 또는 quick "#issue 배포 순서 고민"
quick() {
    _ai_python "$AI_SCRIPTS/quick.py" "$@"
}

# daily-init: 아침 템플릿 생성
# 사용법: daily-init 또는 daily-init 2026-01-15
daily-init() {
    _ai_python "$AI_SCRIPTS/daily.py" --init "$@"
}

# ai-daily: Daily Note에 오늘의 학습 추가
# 사용법: ai-daily 또는 ai-daily 2026-01-15
ai-daily() {
    _ai_python "$AI_SCRIPTS/daily.py" "$@"
}

# ai-weekly: 주간 회고 생성
# 사용법: ai-weekly 또는 ai-weekly --date 2026-01-15
ai-weekly() {
    _ai_python "$AI_SCRIPTS/weekly.py" "$@"
}

# ai-monthly: 월간 리포트 생성
# 사용법: ai-monthly 또는 ai-monthly 2026-01
ai-monthly() {
    _ai_python "$AI_SCRIPTS/monthly.py" "$@"
}

# sync-github: GitHub 활동 동기화
# 사용법: sync-github (어제) 또는 sync-github --today 또는 sync-github 2026-01-15
sync-github() {
    _ai_python "$AI_SCRIPTS/sync_github.py" "$@"
}

# sync-jira: JIRA 활동 동기화
# 사용법: sync-jira (어제) 또는 sync-jira --today 또는 sync-jira 2026-01-15
sync-jira() {
    _ai_python "$AI_SCRIPTS/sync_jira.py" "$@"
}

# sync-all: 모든 활성화된 sync provider 실행
# 사용법: sync-all (어제) 또는 sync-all --today
sync-all() {
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🔄 Sync All Providers"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    sync-github "$@"
    echo ""
    sync-jira "$@"
}

# ai-process: 로그 처리
# 사용법: ai-process ~/path/to/log.jsonl
ai-process() {
    _ai_python "$AI_SCRIPTS/processor.py" --show-prompt "$@"
}

# === 문서 정리 ===

# vacuum: 흩어진 MD 파일 정리
# 사용법: vacuum [프로젝트 경로] [--dry-run] [--to-obsidian] [--json]
vacuum() {
    _ai_python "$AI_SCRIPTS/vacuum.py" "$@"
}

# vacuum-notify: Slack으로 정리할 파일 알림
# 사용법: vacuum-notify [프로젝트 경로]
# 필요: SLACK_WEBHOOK_URL 환경변수
vacuum-notify() {
    "$AI_SCRIPTS/vacuum-notify.sh" "$@"
}

# === 대시보드 ===

# ai-dashboard: Cron 작업 관리 웹 대시보드
# 사용법: ai-dashboard (시작) | ai-dashboard stop (중지)
ai-dashboard() {
    local DASHBOARD_DIR="$AI_PIPELINE_DIR/dashboard"
    local PID_FILE="$DASHBOARD_DIR/.pid"

    case "${1:-start}" in
        start)
            if [ -f "$PID_FILE" ] && kill -0 $(cat "$PID_FILE") 2>/dev/null; then
                echo "✅ Dashboard already running at http://localhost:3030"
                return
            fi
            echo "🚀 Starting AI Pipeline Dashboard..."
            cd "$DASHBOARD_DIR" && nohup node server.js > logs/server.log 2>&1 &
            echo $! > "$PID_FILE"
            sleep 1
            echo "✅ Dashboard started at http://localhost:3030"
            ;;
        stop)
            if [ -f "$PID_FILE" ]; then
                kill $(cat "$PID_FILE") 2>/dev/null
                rm "$PID_FILE"
                echo "🛑 Dashboard stopped"
            else
                echo "Dashboard is not running"
            fi
            ;;
        restart)
            ai-dashboard stop
            sleep 1
            ai-dashboard start
            ;;
        status)
            if [ -f "$PID_FILE" ] && kill -0 $(cat "$PID_FILE") 2>/dev/null; then
                echo "✅ Dashboard running (PID: $(cat $PID_FILE))"
            else
                echo "❌ Dashboard not running"
            fi
            ;;
        log)
            # 전체 로그 출력 후 follow
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo "📜 Dashboard Server Log"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            cat "$DASHBOARD_DIR/logs/server.log"
            echo ""
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo "📡 실시간 로그 (Ctrl+C로 종료)"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            tail -f "$DASHBOARD_DIR/logs/server.log"
            ;;
        logs)
            # 전체 로그만 출력 (follow 없음)
            cat "$DASHBOARD_DIR/logs/server.log"
            ;;
        *)
            echo "Usage: ai-dashboard [start|stop|restart|status|log|logs]"
            echo "  start   - 대시보드 시작"
            echo "  stop    - 대시보드 중지"
            echo "  restart - 대시보드 재시작"
            echo "  status  - 실행 상태 확인"
            echo "  log     - 전체 로그 + 실시간 follow"
            echo "  logs    - 전체 로그만 출력"
            ;;
    esac
}

# === 유틸리티 ===

# ai-check: 환경 검증
# 사용법: ai-check [--api] [--clean]
ai-check() {
    _ai_python "$AI_SCRIPTS/ai_check.py" "$@"
}

# ai-status: 오늘의 기록 상태
ai-status() {
    local today=$(date +%Y-%m-%d)
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📊 AI Pipeline Status: $today"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # Quick notes 확인
    quick --show 2>/dev/null || echo "   Quick Notes: 없음"

    # Daily Note 확인
    local vault_path=$(grep -A1 "^vault:" "$AI_PIPELINE_DIR/config/settings.yaml" | grep "path:" | awk -F'"' '{print $2}')
    local daily_folder=$(grep "daily_folder:" "$AI_PIPELINE_DIR/config/settings.yaml" | awk -F'"' '{print $2}')
    local daily_path="$vault_path/$daily_folder/$today.md"

    if [ -f "$daily_path" ]; then
        echo "   Daily Note: ✅ 존재"
    else
        echo "   Daily Note: ❌ 없음 (daily-init 실행하세요)"
    fi
}

# ai-help: 도움말
ai-help() {
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🤖 AI Pipeline 명령어"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "📝 기록하기"
    echo "  quick \"메모\"         빠른 메모 (#issue, #insight 태그 지원)"
    echo "  daily-init          아침 템플릿 생성"
    echo "  ai-process <log>    AI 대화 로그 처리"
    echo ""
    echo "🔄 동기화"
    echo "  ai-daily            Daily Note에 학습 추가"
    echo "  sync-all            모든 provider 동기화 (GitHub + JIRA)"
    echo "  sync-github         GitHub 활동 동기화"
    echo "  sync-jira           JIRA 활동 동기화"
    echo ""
    echo "📊 리뷰"
    echo "  ai-weekly           주간 회고 생성"
    echo "  ai-monthly          월간 리포트 생성"
    echo ""
    echo "🧹 문서 정리"
    echo "  vacuum <path>       흩어진 MD 파일 정리 (--dry-run, --to-obsidian)"
    echo "  vacuum-notify       Slack으로 정리할 파일 알림"
    echo ""
    echo "📊 대시보드"
    echo "  ai-dashboard        Cron 작업 관리 웹 UI (http://localhost:3030)"
    echo "  ai-dashboard stop   대시보드 중지"
    echo "  ai-dashboard log    서버 로그 보기"
    echo ""
    echo "🔧 유틸리티"
    echo "  ai-check            환경 검증 (--api: API 테스트, --clean: 좀비 정리)"
    echo "  ai-status           오늘의 기록 상태"
    echo "  ai-help             이 도움말"
    echo ""
    echo "🎬 세션 캡처"
    echo "  claude-pipe         Claude 세션 캡처 + 노트 변환"
    echo "  codex-pipe          Codex 세션 캡처 + 노트 변환"
    echo "  llm-pipe <cmd>      임의 CLI 캡처 (예: llm-pipe aider)"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# === LLM CLI Pipe (세션 캡처) ===
# claude-pipe, codex-pipe, llm-pipe 등
if [ -f "$AI_SCRIPTS/llm-cli-pipe.sh" ]; then
    source "$AI_SCRIPTS/llm-cli-pipe.sh"
fi

# 로드 완료 메시지
echo "🤖 AI Pipeline aliases loaded. Type 'ai-help' for commands."

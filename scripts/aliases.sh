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

# === 유틸리티 ===

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
    echo "🔧 유틸리티"
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

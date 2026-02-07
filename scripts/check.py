#!/usr/bin/env python3
"""
AI Pipeline - Environment Check
================================
환경변수, 설정 파일, API 연결 상태를 종합 검증

Usage:
    python check.py          # 전체 검증
    python check.py --fix    # 문제 해결 가이드 표시
    python check.py --json   # JSON 형식 출력
"""

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

import yaml


CONFIG_PATH = Path(__file__).parent.parent / "config" / "settings.yaml"
DASHBOARD_DIR = Path(__file__).parent.parent / "dashboard"


def load_config() -> dict:
    """설정 파일 로드"""
    config_files = [
        CONFIG_PATH.parent / "settings.local.yaml",
        CONFIG_PATH,
        CONFIG_PATH.parent / "settings.example.yaml",
    ]
    for config_file in config_files:
        if config_file.exists():
            with open(config_file, "r", encoding="utf-8") as f:
                return yaml.safe_load(f)
    return {}


class CheckResult:
    """검증 결과"""
    def __init__(self, name: str, category: str):
        self.name = name
        self.category = category
        self.status = "unknown"  # ok, warning, error
        self.message = ""
        self.fix_hint = ""
        self.details = {}

    def ok(self, message: str = ""):
        self.status = "ok"
        self.message = message
        return self

    def warning(self, message: str, fix_hint: str = ""):
        self.status = "warning"
        self.message = message
        self.fix_hint = fix_hint
        return self

    def error(self, message: str, fix_hint: str = ""):
        self.status = "error"
        self.message = message
        self.fix_hint = fix_hint
        return self

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "category": self.category,
            "status": self.status,
            "message": self.message,
            "fix_hint": self.fix_hint,
            "details": self.details,
        }


def check_python_venv() -> CheckResult:
    """Python 가상환경 확인"""
    result = CheckResult("Python venv", "environment")
    venv_path = Path(__file__).parent.parent / ".venv"

    if not venv_path.exists():
        return result.error(
            "가상환경이 없습니다",
            "python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt"
        )

    python_path = venv_path / "bin" / "python"
    if not python_path.exists():
        return result.error("Python 실행 파일이 없습니다")

    # Python 버전 확인
    try:
        version = subprocess.run(
            [str(python_path), "--version"],
            capture_output=True, text=True
        ).stdout.strip()
        result.details["version"] = version
        return result.ok(version)
    except Exception as e:
        return result.error(f"Python 실행 실패: {e}")


def check_env_var(name: str, category: str, required: bool = True,
                  test_fn=None, hint: str = "") -> CheckResult:
    """환경변수 확인"""
    result = CheckResult(name, category)
    value = os.environ.get(name)

    if not value:
        if required:
            return result.error(
                "미설정",
                hint or f"export {name}='your-value'"
            )
        else:
            return result.warning(
                "미설정 (선택사항)",
                hint or f"export {name}='your-value'"
            )

    # 값이 있으면 마스킹해서 표시
    masked = value[:4] + "..." + value[-4:] if len(value) > 12 else "***"
    result.details["masked_value"] = masked

    # 추가 검증 함수가 있으면 실행
    if test_fn:
        try:
            test_result = test_fn(value)
            if test_result:
                return result.ok(f"설정됨 ({masked})")
            else:
                return result.warning(f"설정됨 ({masked}) - 연결 확인 필요")
        except Exception as e:
            return result.warning(f"설정됨 ({masked}) - 검증 실패: {e}")

    return result.ok(f"설정됨 ({masked})")


def check_gh_cli() -> CheckResult:
    """GitHub CLI 확인"""
    result = CheckResult("GitHub CLI (gh)", "tools")

    try:
        # gh 설치 확인
        version_result = subprocess.run(
            ["gh", "--version"],
            capture_output=True, text=True
        )
        if version_result.returncode != 0:
            return result.error(
                "gh CLI가 설치되지 않았습니다",
                "brew install gh"
            )

        version = version_result.stdout.split("\n")[0]
        result.details["version"] = version

        # 인증 확인
        auth_result = subprocess.run(
            ["gh", "auth", "status"],
            capture_output=True, text=True
        )
        if auth_result.returncode != 0:
            return result.warning(
                f"{version} (인증 필요)",
                "gh auth login"
            )

        return result.ok(f"{version} (인증됨)")

    except FileNotFoundError:
        return result.error(
            "gh CLI가 설치되지 않았습니다",
            "brew install gh"
        )


def check_config_file() -> CheckResult:
    """설정 파일 확인"""
    result = CheckResult("설정 파일", "config")

    local_config = CONFIG_PATH.parent / "settings.local.yaml"
    main_config = CONFIG_PATH

    if local_config.exists():
        result.details["file"] = str(local_config)
        return result.ok(f"settings.local.yaml")
    elif main_config.exists():
        result.details["file"] = str(main_config)
        return result.warning(
            "settings.yaml (local 권장)",
            f"cp {main_config} {local_config}"
        )
    else:
        return result.error(
            "설정 파일이 없습니다",
            f"cp {CONFIG_PATH.parent}/settings.example.yaml {local_config}"
        )


def check_obsidian_vault(config: dict) -> CheckResult:
    """Obsidian vault 경로 확인"""
    result = CheckResult("Obsidian Vault", "config")

    vault_config = config.get("vault", {})
    vault_path = vault_config.get("path", "")

    if not vault_path:
        return result.error(
            "vault.path가 설정되지 않았습니다",
            "settings.yaml에서 vault.path 설정"
        )

    vault = Path(vault_path).expanduser()
    if not vault.exists():
        return result.error(
            f"경로가 존재하지 않습니다: {vault_path}",
            "Obsidian vault 경로 확인"
        )

    # 하위 폴더 확인
    daily_folder = vault_config.get("daily_folder", "DAILY")
    drafts_folder = vault_config.get("drafts_folder", "study/_drafts")

    daily_path = vault / daily_folder
    drafts_path = vault / drafts_folder

    missing = []
    if not daily_path.exists():
        missing.append(daily_folder)
    if not drafts_path.exists():
        missing.append(drafts_folder)

    if missing:
        result.details["missing_folders"] = missing
        return result.warning(
            f"일부 폴더 없음: {', '.join(missing)}",
            f"mkdir -p {vault}/{daily_folder} {vault}/{drafts_folder}"
        )

    return result.ok(vault_path)


def check_github_repos(config: dict) -> CheckResult:
    """GitHub 저장소 설정 확인"""
    result = CheckResult("GitHub Repos", "config")

    sync_config = config.get("sync", {})
    github_config = sync_config.get("github", {})
    repos = github_config.get("repos", [])

    if not repos:
        return result.warning(
            "저장소가 설정되지 않았습니다",
            "settings.yaml의 sync.github.repos에 저장소 경로 추가"
        )

    valid_repos = []
    invalid_repos = []

    for repo_path in repos:
        repo = Path(repo_path).expanduser()
        if (repo / ".git").exists():
            valid_repos.append(repo.name)
        else:
            invalid_repos.append(repo_path)

    result.details["valid"] = valid_repos
    result.details["invalid"] = invalid_repos

    if invalid_repos:
        return result.warning(
            f"{len(valid_repos)}개 유효, {len(invalid_repos)}개 무효",
            f"무효 경로: {', '.join(invalid_repos)}"
        )

    return result.ok(f"{len(valid_repos)}개 설정됨")


def check_rss_feeds(config: dict) -> CheckResult:
    """RSS 피드 설정 확인"""
    result = CheckResult("RSS 피드", "config")

    rss_config = config.get("rss", {})
    feeds = rss_config.get("feeds", [])

    if not feeds:
        return result.warning(
            "피드가 설정되지 않았습니다",
            "settings.yaml의 rss.feeds에 피드 URL 추가"
        )

    result.details["count"] = len(feeds)
    feed_names = [f.get("name", f.get("url", "?")[:30]) for f in feeds[:5]]
    return result.ok(f"{len(feeds)}개 ({', '.join(feed_names)})")


def check_cloudwatch(config: dict) -> CheckResult:
    """CloudWatch 설정 확인"""
    result = CheckResult("CloudWatch", "config")

    monitor_config = config.get("monitor", {})
    cw_config = monitor_config.get("cloudwatch", {})
    log_groups = cw_config.get("log_groups", [])

    if not log_groups:
        return result.warning(
            "로그 그룹이 설정되지 않았습니다",
            "settings.yaml의 monitor.cloudwatch.log_groups에 로그 그룹 추가"
        )

    result.details["count"] = len(log_groups)
    return result.ok(f"{len(log_groups)}개 설정됨")


def check_dashboard_status() -> CheckResult:
    """대시보드 상태 확인"""
    result = CheckResult("Dashboard", "services")

    pid_file = DASHBOARD_DIR / ".pid"

    if not pid_file.exists():
        return result.warning(
            "실행 중이 아님",
            "ai-dashboard start"
        )

    try:
        pid = int(pid_file.read_text().strip())
        # 프로세스 존재 확인
        os.kill(pid, 0)
        result.details["pid"] = pid
        return result.ok(f"실행 중 (PID: {pid}, http://localhost:3030)")
    except (ProcessLookupError, ValueError):
        return result.warning(
            "PID 파일 있으나 프로세스 없음",
            "ai-dashboard restart"
        )
    except PermissionError:
        result.details["pid"] = pid
        return result.ok(f"실행 중 (PID: {pid})")


def check_history_health() -> CheckResult:
    """실행 기록 상태 확인"""
    result = CheckResult("실행 기록", "health")

    history_file = DASHBOARD_DIR / "logs" / "history.json"

    if not history_file.exists():
        return result.warning("기록 파일 없음")

    try:
        with open(history_file, "r", encoding="utf-8") as f:
            history = json.load(f)

        total = len(history)
        running = sum(1 for h in history if h.get("status") == "running")
        failed = sum(1 for h in history if h.get("status") == "failed")
        success = sum(1 for h in history if h.get("status") == "success")

        result.details = {
            "total": total,
            "running": running,
            "failed": failed,
            "success": success,
        }

        if running > 0:
            return result.warning(
                f"총 {total}건 (좀비 작업 {running}건 있음)",
                "오래된 running 상태 작업 정리 필요"
            )

        success_rate = round(success / (success + failed) * 100) if (success + failed) > 0 else 0
        return result.ok(f"총 {total}건 (성공률 {success_rate}%)")

    except Exception as e:
        return result.error(f"기록 파일 읽기 실패: {e}")


def check_disk_space() -> CheckResult:
    """디스크 공간 확인"""
    result = CheckResult("디스크 공간", "health")

    try:
        import shutil
        total, used, free = shutil.disk_usage("/")
        free_gb = free // (1024 ** 3)
        used_percent = round(used / total * 100)

        result.details = {
            "free_gb": free_gb,
            "used_percent": used_percent,
        }

        if free_gb < 5:
            return result.error(
                f"{free_gb}GB 남음 ({used_percent}% 사용)",
                "디스크 정리 필요"
            )
        elif free_gb < 20:
            return result.warning(
                f"{free_gb}GB 남음 ({used_percent}% 사용)",
                "temp-cleanup 실행 권장"
            )

        return result.ok(f"{free_gb}GB 남음 ({used_percent}% 사용)")

    except Exception as e:
        return result.error(f"확인 실패: {e}")


def print_results(results: list[CheckResult], show_fix: bool = False):
    """결과 출력"""
    icons = {
        "ok": "✅",
        "warning": "⚠️ ",
        "error": "❌",
        "unknown": "❓",
    }

    # 카테고리별 그룹화
    categories = {}
    for r in results:
        if r.category not in categories:
            categories[r.category] = []
        categories[r.category].append(r)

    category_names = {
        "environment": "🔧 환경",
        "tools": "🛠️  도구",
        "config": "⚙️  설정",
        "services": "🚀 서비스",
        "health": "💚 상태",
    }

    print("\n" + "━" * 50)
    print("🔍 AI Pipeline 환경 검증")
    print("━" * 50)

    for category, cat_results in categories.items():
        cat_name = category_names.get(category, category)
        print(f"\n{cat_name}")
        print("-" * 40)

        for r in cat_results:
            icon = icons.get(r.status, "❓")
            print(f"  {icon} {r.name}: {r.message}")

            if show_fix and r.fix_hint and r.status in ("warning", "error"):
                print(f"      💡 {r.fix_hint}")

    # 요약
    ok_count = sum(1 for r in results if r.status == "ok")
    warn_count = sum(1 for r in results if r.status == "warning")
    error_count = sum(1 for r in results if r.status == "error")

    print("\n" + "━" * 50)
    print(f"📊 요약: ✅ {ok_count} / ⚠️  {warn_count} / ❌ {error_count}")

    if error_count > 0:
        print("\n💡 --fix 옵션으로 해결 방법을 확인하세요.")

    print("━" * 50 + "\n")


def main():
    # 옵션 파싱
    args = sys.argv[1:]
    show_fix = "--fix" in args
    json_output = "--json" in args

    # 설정 로드
    config = load_config()

    # 검증 실행
    results = []

    # 환경
    results.append(check_python_venv())

    # 도구
    results.append(check_gh_cli())

    # 환경변수
    results.append(check_env_var(
        "GOOGLE_API_KEY", "environment",
        required=False,
        hint="Google AI Studio에서 발급: https://aistudio.google.com/apikey"
    ))
    results.append(check_env_var(
        "SLACK_WEBHOOK_URL", "environment",
        required=False,
        hint="Slack 앱에서 웹훅 생성: https://api.slack.com/messaging/webhooks"
    ))
    results.append(check_env_var(
        "JIRA_EMAIL", "environment",
        required=False,
        hint="Atlassian 계정 이메일"
    ))
    results.append(check_env_var(
        "JIRA_API_TOKEN", "environment",
        required=False,
        hint="API 토큰 발급: https://id.atlassian.com/manage-profile/security/api-tokens"
    ))

    # 설정
    results.append(check_config_file())
    results.append(check_obsidian_vault(config))
    results.append(check_github_repos(config))
    results.append(check_rss_feeds(config))
    results.append(check_cloudwatch(config))

    # 서비스
    results.append(check_dashboard_status())

    # 상태
    results.append(check_history_health())
    results.append(check_disk_space())

    # 출력
    if json_output:
        output = {
            "results": [r.to_dict() for r in results],
            "summary": {
                "ok": sum(1 for r in results if r.status == "ok"),
                "warning": sum(1 for r in results if r.status == "warning"),
                "error": sum(1 for r in results if r.status == "error"),
            }
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
    else:
        print_results(results, show_fix=show_fix)

    # 종료 코드
    error_count = sum(1 for r in results if r.status == "error")
    sys.exit(1 if error_count > 0 else 0)


if __name__ == "__main__":
    main()

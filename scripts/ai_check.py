#!/usr/bin/env python3
"""
AI Pipeline 환경 검증 스크립트
모든 환경변수, API 연결, 설정 파일을 검사합니다.
"""

import os
import sys
import json
import socket
import subprocess
from pathlib import Path
from datetime import datetime

# 색상 코드
class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    BOLD = '\033[1m'
    END = '\033[0m'

def ok(msg):
    return f"{Colors.GREEN}✅{Colors.END} {msg}"

def fail(msg):
    return f"{Colors.RED}❌{Colors.END} {msg}"

def warn(msg):
    return f"{Colors.YELLOW}⚠️{Colors.END}  {msg}"

def info(msg):
    return f"{Colors.BLUE}ℹ️{Colors.END}  {msg}"

def header(msg):
    return f"{Colors.BOLD}{Colors.CYAN}{msg}{Colors.END}"

# 경로 설정
PIPELINE_ROOT = Path(__file__).parent.parent
SCRIPTS_DIR = PIPELINE_ROOT / "scripts"
DASHBOARD_DIR = PIPELINE_ROOT / "dashboard"
CONFIG_FILE = SCRIPTS_DIR / "config.json"
JOBS_FILE = DASHBOARD_DIR / "jobs.json"
HISTORY_DIR = DASHBOARD_DIR / "logs"

def print_section(title):
    print(f"\n{header('━' * 40)}")
    print(header(f"  {title}"))
    print(header('━' * 40))

def check_python_env():
    """Python 환경 검사"""
    print_section("🐍 Python 환경")

    results = []

    # venv 확인
    venv_path = PIPELINE_ROOT / ".venv"
    if venv_path.exists():
        results.append(ok(f"Python venv: {venv_path}"))
    else:
        results.append(fail("Python venv: .venv 폴더 없음"))

    # Python 버전
    try:
        version = sys.version.split()[0]
        if version.startswith("3."):
            results.append(ok(f"Python 버전: {version}"))
        else:
            results.append(warn(f"Python 버전: {version} (3.x 권장)"))
    except:
        results.append(fail("Python 버전 확인 실패"))

    # 필수 패키지 확인
    required_packages = [
        'requests', 'feedparser', 'google.generativeai',
        'jira', 'openai', 'tiktoken'
    ]

    for pkg in required_packages:
        try:
            __import__(pkg.split('.')[0])
            results.append(ok(f"패키지 {pkg}: 설치됨"))
        except ImportError:
            results.append(fail(f"패키지 {pkg}: 미설치 (pip install {pkg})"))

    for r in results:
        print(f"  {r}")

    return results

def check_env_variables():
    """환경변수 검사"""
    print_section("🔑 환경변수")

    results = []

    env_vars = {
        'GOOGLE_API_KEY': ('Gemini API', True),
        'OPENAI_API_KEY': ('OpenAI API', False),
        'SLACK_WEBHOOK_URL': ('Slack 알림', False),
        'JIRA_SERVER': ('JIRA 서버', False),
        'JIRA_EMAIL': ('JIRA 이메일', False),
        'JIRA_API_TOKEN': ('JIRA API 토큰', False),
        'OBSIDIAN_VAULT': ('Obsidian 볼트', False),
    }

    for var, (desc, required) in env_vars.items():
        value = os.getenv(var)
        if value:
            # 마스킹 처리
            masked = value[:8] + '...' if len(value) > 12 else '***'
            results.append(ok(f"{desc} ({var}): {masked}"))
        elif required:
            results.append(fail(f"{desc} ({var}): 미설정 [필수]"))
        else:
            results.append(warn(f"{desc} ({var}): 미설정"))

    for r in results:
        print(f"  {r}")

    return results

def check_config_files():
    """설정 파일 검사"""
    print_section("📄 설정 파일")

    results = []

    # config.json 검사
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE) as f:
                config = json.load(f)
            results.append(ok(f"config.json: 존재"))

            # RSS 피드 확인
            rss_feeds = config.get('rss', {}).get('feeds', [])
            if rss_feeds:
                results.append(ok(f"RSS 피드: {len(rss_feeds)}개 설정됨"))
            else:
                results.append(warn("RSS 피드: 0개 설정됨"))

            # GitHub repos 확인
            github_repos = config.get('github', {}).get('local_repos', [])
            if github_repos:
                valid_repos = [r for r in github_repos if Path(r).expanduser().exists()]
                results.append(ok(f"GitHub repos: {len(valid_repos)}/{len(github_repos)}개 유효"))
            else:
                results.append(warn("GitHub repos: 0개 설정됨"))

            # CloudWatch 로그 그룹 확인
            cw_groups = config.get('cloudwatch', {}).get('log_groups', [])
            if cw_groups:
                results.append(ok(f"CloudWatch 로그 그룹: {len(cw_groups)}개"))
            else:
                results.append(warn("CloudWatch 로그 그룹: 0개 설정됨"))

        except json.JSONDecodeError:
            results.append(fail("config.json: JSON 파싱 오류"))
        except Exception as e:
            results.append(fail(f"config.json: {e}"))
    else:
        results.append(fail(f"config.json: 파일 없음 ({CONFIG_FILE})"))

    # jobs.json 검사
    if JOBS_FILE.exists():
        try:
            with open(JOBS_FILE) as f:
                jobs_data = json.load(f)

            jobs = jobs_data.get('jobs', [])
            enabled_jobs = [j for j in jobs if j.get('enabled')]
            results.append(ok(f"jobs.json: {len(enabled_jobs)}/{len(jobs)}개 활성화"))

            # 설정 확인
            settings = jobs_data.get('settings', {})
            if settings.get('slackWebhookUrl'):
                results.append(ok("대시보드 Slack 설정: 있음"))
            else:
                results.append(warn("대시보드 Slack 설정: 없음"))

        except Exception as e:
            results.append(fail(f"jobs.json: {e}"))
    else:
        results.append(warn(f"jobs.json: 파일 없음 (대시보드 미사용?)"))

    for r in results:
        print(f"  {r}")

    return results

def check_services():
    """서비스 상태 검사"""
    print_section("🌐 서비스 상태")

    results = []

    # 대시보드 포트 확인 (3030)
    dashboard_port = 3030
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(1)
    port_open = sock.connect_ex(('localhost', dashboard_port)) == 0
    sock.close()

    if port_open:
        results.append(ok(f"대시보드 (:{dashboard_port}): 실행 중"))
    else:
        results.append(warn(f"대시보드 (:{dashboard_port}): 미실행"))

    # Node.js 확인
    try:
        node_version = subprocess.check_output(['node', '--version'],
                                               stderr=subprocess.DEVNULL).decode().strip()
        results.append(ok(f"Node.js: {node_version}"))
    except:
        results.append(warn("Node.js: 미설치 또는 PATH에 없음"))

    for r in results:
        print(f"  {r}")

    return results

def check_history():
    """실행 이력 검사"""
    print_section("📊 실행 이력")

    results = []

    # history.json 확인
    history_file = DASHBOARD_DIR / "logs" / "history.json"
    if history_file.exists():
        try:
            with open(history_file) as f:
                history = json.load(f)

            total = len(history)
            running = [h for h in history if h.get('status') == 'running']
            failed = [h for h in history if h.get('status') == 'failed']
            success = [h for h in history if h.get('status') == 'success']

            results.append(info(f"총 실행 기록: {total}개"))
            results.append(ok(f"성공: {len(success)}개"))

            if failed:
                results.append(warn(f"실패: {len(failed)}개"))
            else:
                results.append(ok("실패: 0개"))

            # 좀비 작업 (running 상태로 멈춘 작업)
            if running:
                results.append(fail(f"좀비 작업 (running 상태): {len(running)}개"))
                for r in running[:3]:  # 최대 3개만 표시
                    results.append(f"    └─ {r.get('jobName', 'unknown')} (시작: {r.get('startTime', '?')[:16]})")
            else:
                results.append(ok("좀비 작업: 없음"))

        except Exception as e:
            results.append(fail(f"history.json 읽기 실패: {e}"))
    else:
        results.append(info("history.json: 파일 없음 (아직 실행 기록 없음)"))

    for r in results:
        print(f"  {r}")

    return results

def check_api_connectivity():
    """API 연결 테스트"""
    print_section("🔗 API 연결 테스트")

    results = []

    # Google Gemini API
    if os.getenv('GOOGLE_API_KEY'):
        try:
            import google.generativeai as genai
            genai.configure(api_key=os.getenv('GOOGLE_API_KEY'))
            # 간단한 테스트 (모델 목록 조회)
            models = list(genai.list_models())
            results.append(ok(f"Google Gemini API: 연결됨 ({len(models)}개 모델)"))
        except Exception as e:
            results.append(fail(f"Google Gemini API: {str(e)[:50]}"))
    else:
        results.append(warn("Google Gemini API: API 키 없음"))

    # JIRA API (설정된 경우만)
    if os.getenv('JIRA_SERVER') and os.getenv('JIRA_EMAIL') and os.getenv('JIRA_API_TOKEN'):
        try:
            from jira import JIRA
            jira = JIRA(
                server=os.getenv('JIRA_SERVER'),
                basic_auth=(os.getenv('JIRA_EMAIL'), os.getenv('JIRA_API_TOKEN'))
            )
            user = jira.current_user()
            results.append(ok(f"JIRA API: 연결됨 ({user})"))
        except Exception as e:
            results.append(fail(f"JIRA API: {str(e)[:50]}"))
    else:
        results.append(warn("JIRA API: 자격 증명 미설정"))

    # Slack Webhook (설정된 경우만)
    slack_url = os.getenv('SLACK_WEBHOOK_URL')
    if slack_url:
        try:
            import requests
            # dry-run 테스트 (실제 메시지 전송 안함)
            resp = requests.post(slack_url, json={"text": ""}, timeout=5)
            if resp.status_code in [200, 400]:  # 400은 빈 메시지라 OK
                results.append(ok("Slack Webhook: 연결됨"))
            else:
                results.append(fail(f"Slack Webhook: HTTP {resp.status_code}"))
        except Exception as e:
            results.append(fail(f"Slack Webhook: {str(e)[:50]}"))
    else:
        results.append(warn("Slack Webhook: URL 미설정"))

    for r in results:
        print(f"  {r}")

    return results

def clean_zombie_jobs():
    """좀비 작업 정리"""
    history_file = DASHBOARD_DIR / "logs" / "history.json"
    if not history_file.exists():
        return 0

    try:
        with open(history_file) as f:
            history = json.load(f)

        cleaned = 0
        for h in history:
            if h.get('status') == 'running':
                h['status'] = 'failed'
                h['error'] = 'Marked as failed (zombie cleanup)'
                h['endTime'] = datetime.now().isoformat()
                cleaned += 1

        if cleaned > 0:
            with open(history_file, 'w') as f:
                json.dump(history, f, indent=2, ensure_ascii=False)

        return cleaned
    except:
        return 0

def main():
    print(f"\n{Colors.BOLD}{Colors.CYAN}")
    print("╔══════════════════════════════════════════╗")
    print("║    🔍 AI Pipeline 환경 검증              ║")
    print("╚══════════════════════════════════════════╝")
    print(Colors.END)
    print(f"  검사 시간: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  파이프라인 경로: {PIPELINE_ROOT}")

    all_results = []

    # 각 검사 실행
    all_results.extend(check_python_env())
    all_results.extend(check_env_variables())
    all_results.extend(check_config_files())
    all_results.extend(check_services())
    all_results.extend(check_history())

    # API 연결 테스트 (--api 플래그가 있을 때만)
    if '--api' in sys.argv:
        all_results.extend(check_api_connectivity())
    else:
        print(f"\n  {info('API 연결 테스트: --api 플래그로 실행')}")

    # 좀비 작업 정리 (--clean 플래그)
    if '--clean' in sys.argv:
        print_section("🧹 정리 작업")
        cleaned = clean_zombie_jobs()
        if cleaned > 0:
            print(f"  {ok(f'좀비 작업 {cleaned}개 정리됨')}")
        else:
            print(f"  {info('정리할 작업 없음')}")

    # 요약
    print_section("📋 요약")

    ok_count = sum(1 for r in all_results if '✅' in r)
    fail_count = sum(1 for r in all_results if '❌' in r)
    warn_count = sum(1 for r in all_results if '⚠️' in r)

    print(f"  {Colors.GREEN}✅ 정상: {ok_count}개{Colors.END}")
    print(f"  {Colors.YELLOW}⚠️  경고: {warn_count}개{Colors.END}")
    print(f"  {Colors.RED}❌ 오류: {fail_count}개{Colors.END}")

    if fail_count > 0:
        print(f"\n  {Colors.RED}일부 항목에 문제가 있습니다. 위의 오류를 확인하세요.{Colors.END}")
        sys.exit(1)
    elif warn_count > 0:
        print(f"\n  {Colors.YELLOW}일부 경고가 있지만 기본 기능은 동작합니다.{Colors.END}")
    else:
        print(f"\n  {Colors.GREEN}모든 검사를 통과했습니다! 🎉{Colors.END}")

    print(f"\n  사용법: ai-check [--api] [--clean]")
    print(f"    --api   : API 연결 테스트 포함")
    print(f"    --clean : 좀비 작업 정리\n")

if __name__ == '__main__':
    main()

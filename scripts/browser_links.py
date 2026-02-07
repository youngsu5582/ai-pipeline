#!/usr/bin/env python3
"""
AI Pipeline - Browser Links Collector
======================================
브라우저 열린 탭의 URL과 제목을 수집하여 Obsidian에 저장

Usage:
    python browser_links.py                              # Chrome 탭 (기본)
    python browser_links.py --browser arc                # Arc 탭
    python browser_links.py --browser all                # Chrome + Arc 모두
    python browser_links.py --exclude "google.com,mail"  # 특정 도메인 제외
    python browser_links.py --output ~/notes/reading     # 저장 경로 지정
    python browser_links.py --yes                        # Obsidian에 자동 저장

Options:
    --browser BROWSER        브라우저 선택 (chrome/arc/all, 기본: chrome)
    --exclude DOMAIN,...     쉼표로 구분된 제외 도메인 패턴
    --output PATH            저장 폴더 경로 (기본: vault/reading)
    --yes                    확인 없이 저장
    --slack                  Slack 알림 전송

Requirements:
    - macOS (AppleScript 사용)
    - Google Chrome 또는 Arc Browser 설치
    - config/settings.yaml에 vault 설정
"""

import os
import subprocess
import sys
import urllib.request
import json
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import yaml


CONFIG_PATH = Path(__file__).parent.parent / "config" / "settings.yaml"


def load_config() -> dict:
    """설정 파일 로드 (우선순위 적용)"""
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


CONFIG = load_config()


def get_chrome_tabs() -> list[dict]:
    """Chrome 열린 탭 정보 수집 (AppleScript)"""
    tabs = []

    script = '''
    tell application "Google Chrome"
        set tabList to {}
        repeat with w in windows
            repeat with t in tabs of w
                set tabInfo to {URL of t, title of t}
                set end of tabList to tabInfo
            end repeat
        end repeat
        return tabList
    end tell
    '''

    tabs = _run_browser_script(script, "Chrome")
    return tabs


def get_arc_tabs() -> list[dict]:
    """Arc Browser 열린 탭 정보 수집 (AppleScript)"""
    # Arc는 spaces와 tabs 구조를 가짐
    script = '''
    tell application "Arc"
        set tabList to {}
        repeat with w in windows
            repeat with t in tabs of w
                try
                    set tabURL to URL of t
                    set tabTitle to title of t
                    if tabURL is not missing value then
                        set end of tabList to {tabURL, tabTitle}
                    end if
                end try
            end repeat
        end repeat
        return tabList
    end tell
    '''

    tabs = _run_browser_script(script, "Arc")
    return tabs


def _run_browser_script(script: str, browser_name: str) -> list[dict]:
    """AppleScript 실행 및 결과 파싱 (공통)"""
    tabs = []

    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=10,
        )

        if result.returncode != 0:
            if "not running" in result.stderr.lower():
                print(f"⚠️  {browser_name}이(가) 실행 중이 아닙니다.")
            elif "application" in result.stderr.lower() and "found" in result.stderr.lower():
                print(f"⚠️  {browser_name}이(가) 설치되어 있지 않습니다.")
            else:
                print(f"⚠️  {browser_name} AppleScript 오류: {result.stderr}")
            return []

        output = result.stdout.strip()
        if not output or output == "{}":
            return []

        # AppleScript 출력 파싱
        items = output.strip("{}").split(", ")

        i = 0
        while i < len(items) - 1:
            url = items[i].strip().strip('"')
            title = items[i + 1].strip().strip('"')

            if url.startswith(("http://", "https://")):
                tabs.append({
                    "url": url,
                    "title": title,
                    "domain": urlparse(url).netloc,
                    "browser": browser_name,
                })
            i += 2

    except subprocess.TimeoutExpired:
        print(f"⚠️  {browser_name} 응답 시간 초과")
    except Exception as e:
        print(f"⚠️  {browser_name} 탭 수집 실패: {e}")

    return tabs


def get_browser_tabs(browser: str = "chrome", exclude_domains: list[str] = None) -> list[dict]:
    """브라우저 탭 수집 (브라우저 선택)

    Args:
        browser: 수집할 브라우저 (chrome/arc/all)
        exclude_domains: 제외할 도메인 패턴 목록
    """
    tabs = []

    browser = browser.lower()

    if browser in ("chrome", "all"):
        print("   🌐 Chrome 탭 수집 중...")
        chrome_tabs = get_chrome_tabs()
        tabs.extend(chrome_tabs)
        print(f"      Chrome: {len(chrome_tabs)}개")

    if browser in ("arc", "all"):
        print("   🌐 Arc 탭 수집 중...")
        arc_tabs = get_arc_tabs()
        tabs.extend(arc_tabs)
        print(f"      Arc: {len(arc_tabs)}개")

    # 중복 URL 제거 (같은 URL이 여러 브라우저에 있을 수 있음)
    seen_urls = set()
    unique_tabs = []
    for tab in tabs:
        if tab["url"] not in seen_urls:
            seen_urls.add(tab["url"])
            unique_tabs.append(tab)

    # 도메인 필터링
    if exclude_domains:
        filtered_tabs = []
        for tab in unique_tabs:
            domain = tab.get("domain", "")
            url = tab.get("url", "")
            # 제외 패턴과 매칭되지 않으면 유지
            if not any(pattern.lower() in domain.lower() or pattern.lower() in url.lower()
                      for pattern in exclude_domains):
                filtered_tabs.append(tab)
        print(f"   🚫 도메인 필터링: {len(unique_tabs) - len(filtered_tabs)}개 제외")
        unique_tabs = filtered_tabs

    return unique_tabs


def categorize_tabs(tabs: list[dict]) -> dict[str, list[dict]]:
    """탭을 카테고리별로 분류"""
    categories = {
        "개발 문서": [],
        "기술 블로그": [],
        "GitHub": [],
        "학습/강의": [],
        "뉴스/참고": [],
        "기타": [],
    }

    # 도메인별 카테고리 매핑
    domain_mapping = {
        # 개발 문서
        "docs.": "개발 문서",
        "developer.": "개발 문서",
        "spring.io": "개발 문서",
        "kotlinlang.org": "개발 문서",
        "reactjs.org": "개발 문서",
        "typescriptlang.org": "개발 문서",
        "nodejs.org": "개발 문서",
        "postgresql.org": "개발 문서",
        "redis.io": "개발 문서",
        "kafka.apache.org": "개발 문서",
        "aws.amazon.com/docs": "개발 문서",

        # 기술 블로그
        "medium.com": "기술 블로그",
        "dev.to": "기술 블로그",
        "velog.io": "기술 블로그",
        "tistory.com": "기술 블로그",
        "naver.com/blog": "기술 블로그",
        "techblog": "기술 블로그",

        # GitHub
        "github.com": "GitHub",
        "gist.github.com": "GitHub",

        # 학습/강의
        "youtube.com": "학습/강의",
        "udemy.com": "학습/강의",
        "coursera.org": "학습/강의",
        "inflearn.com": "학습/강의",
        "nomadcoders.co": "학습/강의",

        # 뉴스/참고
        "stackoverflow.com": "뉴스/참고",
        "news.ycombinator.com": "뉴스/참고",
    }

    for tab in tabs:
        url = tab.get("url", "")
        domain = tab.get("domain", "")

        # 카테고리 결정
        category = "기타"
        for pattern, cat in domain_mapping.items():
            if pattern in url or pattern in domain:
                category = cat
                break

        categories[category].append(tab)

    return categories


def build_reading_note(categorized_tabs: dict[str, list[dict]], target_date: str) -> str:
    """읽기 목록 노트 생성"""
    lines = [
        f"# 브라우저 탭 정리 - {target_date}",
        "",
        f"> 수집 시각: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        "",
    ]

    total_count = sum(len(tabs) for tabs in categorized_tabs.values())
    lines.append(f"총 {total_count}개의 탭")
    lines.append("")

    # 카테고리별 출력
    for category, tabs in categorized_tabs.items():
        if not tabs:
            continue

        lines.append(f"## {category}")
        lines.append("")

        for tab in tabs:
            title = tab.get("title", "Untitled")
            url = tab.get("url", "")
            domain = tab.get("domain", "")
            browser = tab.get("browser", "")

            # 제목이 너무 길면 자르기
            if len(title) > 80:
                title = title[:80] + "..."

            lines.append(f"- [{title}]({url})")
            browser_badge = f" ({browser})" if browser else ""
            lines.append(f"  - `{domain}`{browser_badge}")

        lines.append("")

    return "\n".join(lines)


def get_reading_folder_path(override_path: str = None) -> Path:
    """읽기 목록 폴더 경로

    Args:
        override_path: 옵션으로 지정된 저장 경로
    """
    if override_path:
        return Path(override_path).expanduser()

    vault_path = Path(CONFIG["vault"]["path"]).expanduser()
    return vault_path / "reading"


def save_reading_note(content: str, target_date: str, output_path: str = None) -> str:
    """읽기 목록 노트 저장

    Args:
        content: 저장할 내용
        target_date: 날짜
        output_path: 저장 폴더 경로 (옵션)
    """
    reading_folder = get_reading_folder_path(output_path)
    reading_folder.mkdir(parents=True, exist_ok=True)

    note_path = reading_folder / f"{target_date}.md"

    # 기존 파일이 있으면 병합
    if note_path.exists():
        with open(note_path, "r", encoding="utf-8") as f:
            existing = f.read()

        # 기존 내용 아래에 새 내용 추가
        content = existing.rstrip() + "\n\n---\n\n" + content

    with open(note_path, "w", encoding="utf-8") as f:
        f.write(content)

    return str(note_path)


def send_slack_notification(tabs: list[dict]) -> bool:
    """Slack으로 알림 전송"""
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL")

    if not webhook_url:
        print("⚠️  SLACK_WEBHOOK_URL 환경변수가 설정되지 않았습니다.")
        return False

    if not tabs:
        return True

    blocks = [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": f"🔗 브라우저 탭 정리 ({len(tabs)}개)",
                "emoji": True
            }
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"Chrome에서 {len(tabs)}개의 탭을 Obsidian에 저장했습니다."
            }
        },
    ]

    # 몇 개만 샘플로 표시
    sample_tabs = tabs[:5]
    if sample_tabs:
        blocks.append({"type": "divider"})
        for tab in sample_tabs:
            blocks.append({
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f"• <{tab['url']}|{tab['title'][:50]}>"
                }
            })

    if len(tabs) > 5:
        blocks.append({
            "type": "context",
            "elements": [
                {"type": "mrkdwn", "text": f"_...외 {len(tabs) - 5}개_"}
            ]
        })

    payload = {"blocks": blocks}

    try:
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            webhook_url,
            data=data,
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status == 200
    except Exception as e:
        print(f"⚠️  Slack 알림 전송 실패: {e}")
        return False


def print_summary(categorized_tabs: dict[str, list[dict]]):
    """콘솔에 요약 출력"""
    print("\n" + "━" * 50)
    print("🔗 브라우저 탭 수집 결과")
    print("━" * 50)

    total = sum(len(tabs) for tabs in categorized_tabs.values())
    if total == 0:
        print("열린 탭이 없습니다.")
        return

    print(f"총 {total}개의 탭")
    print("")

    for category, tabs in categorized_tabs.items():
        if tabs:
            print(f"{category}: {len(tabs)}개")
            for tab in tabs[:3]:
                title = tab.get("title", "")[:50]
                print(f"  - {title}")
            if len(tabs) > 3:
                print(f"  - ...외 {len(tabs) - 3}개")
            print("")

    print("━" * 50)


def main():
    # 옵션 파싱
    args = sys.argv[1:]

    yes_mode = False
    slack_mode = False
    browser = "chrome"  # 기본값
    exclude_domains = None  # 제외할 도메인
    output_path = None  # 저장 경로

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--yes", "-y"):
            yes_mode = True
            i += 1
        elif arg == "--slack":
            slack_mode = True
            i += 1
        elif arg == "--browser" and i + 1 < len(args):
            browser = args[i + 1]
            i += 2
        elif arg == "--exclude" and i + 1 < len(args):
            exclude_domains = [d.strip() for d in args[i + 1].split(",") if d.strip()]
            i += 2
        elif arg == "--output" and i + 1 < len(args):
            output_path = args[i + 1]
            i += 2
        else:
            i += 1

    today = datetime.now().strftime("%Y-%m-%d")

    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"🔗 Browser Links Collector: {today}")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"   브라우저: {browser.upper()}")
    if exclude_domains:
        print(f"   제외 도메인: {', '.join(exclude_domains)}")
    if output_path:
        print(f"   저장 경로: {output_path}")

    # 탭 수집
    print("\n📡 탭 수집 중...")
    tabs = get_browser_tabs(browser, exclude_domains)
    print(f"   총 수집된 탭: {len(tabs)}개")

    if not tabs:
        print("\n⚠️  수집된 탭이 없습니다.")
        return

    # 카테고리 분류
    categorized = categorize_tabs(tabs)

    # 콘솔 출력
    print_summary(categorized)

    # 노트 생성
    note_content = build_reading_note(categorized, today)

    # 미리보기
    print("\n📋 Obsidian 노트 미리보기")
    print("━" * 40)
    preview = note_content[:500]
    if len(note_content) > 500:
        preview += "\n..."
    print(preview)
    print("━" * 40)

    # 저장
    if yes_mode:
        choice = "y"
    else:
        try:
            choice = input("\nObsidian에 저장할까요? [Y/n]: ").strip().lower()
        except EOFError:
            choice = "y"

    if choice in ["", "y", "yes"]:
        result_path = save_reading_note(note_content, today, output_path)
        print(f"\n✅ 저장 완료!")
        print(f"   {result_path}")
    else:
        print("\n⏭️  건너뛰었습니다.")

    # Slack 알림
    if slack_mode:
        print("\n📤 Slack 알림 전송 중...")
        if send_slack_notification(tabs):
            print("✅ Slack 알림 전송 완료!")
        else:
            print("❌ Slack 알림 전송 실패")


if __name__ == "__main__":
    main()

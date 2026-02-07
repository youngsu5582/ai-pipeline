#!/usr/bin/env python3
"""
AI Pipeline - RSS Feed Collector
=================================
RSS 피드를 수집하여 Obsidian reading 폴더에 저장

Usage:
    python rss_collector.py                     # 설정 파일 피드 수집
    python rss_collector.py --yes               # 자동 저장
    python rss_collector.py --days 3            # 최근 3일 글만
    python rss_collector.py --feeds "url1,url2" # 특정 피드만 수집
    python rss_collector.py --skip-existing     # 이미 있는 글 건너뛰기

Options:
    --feeds URL,...    쉼표로 구분된 RSS 피드 URL 목록
    --days N           최근 N일간 글만 수집 (기본: 7)
    --yes              확인 없이 자동 저장
    --slack            Slack 알림 전송
    --skip-existing    Obsidian에 이미 있는 글 건너뛰기 (설정 파일에서도 가능)
    --no-skip          중복 방지 비활성화 (설정 파일 덮어쓰기)

Requirements:
    - feedparser 설치 (pip install feedparser)
    - config/settings.yaml에 rss.feeds 설정 (--feeds 미지정 시)
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional
from email.utils import parsedate_to_datetime

try:
    import feedparser
except ImportError:
    print("❌ feedparser가 설치되어 있지 않습니다.")
    print("   pip install feedparser")
    sys.exit(1)

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


def get_rss_config() -> dict:
    """RSS 설정 조회"""
    return CONFIG.get("rss", {})


def get_feeds(override_urls: list[str] = None) -> list[dict]:
    """RSS 피드 목록 조회

    Args:
        override_urls: 옵션으로 전달된 URL 목록 (설정 파일 대신 사용)
    """
    # 옵션으로 피드 URL이 전달된 경우
    if override_urls:
        feeds = []
        for url in override_urls:
            url = url.strip()
            if not url:
                continue
            # URL에서 이름 추출 (도메인 기준)
            try:
                from urllib.parse import urlparse
                domain = urlparse(url).netloc
                name = domain.replace("www.", "").split(".")[0].title()
            except Exception:
                name = "Unknown"

            feeds.append({
                "url": url,
                "name": name,
                "category": "custom"
            })
        return feeds

    # 설정 파일에서 조회
    rss_config = get_rss_config()
    feeds = rss_config.get("feeds", [])

    if not feeds:
        print("⚠️  RSS 피드가 설정되지 않았습니다.")
        print("   config/settings.yaml에 rss.feeds를 설정하거나")
        print("   --feeds 옵션으로 URL을 지정하세요.")
        print("")
        print("   예시:")
        print("   rss:")
        print("     feeds:")
        print('       - url: "https://example.com/feed.xml"')
        print('         name: "Example Blog"')
        print('         category: "tech"')
        print("")
        print("   또는: python rss_collector.py --feeds \"https://blog.example.com/feed\"")
        return []

    return feeds


def parse_date(entry) -> Optional[datetime]:
    """RSS 엔트리에서 날짜 파싱"""
    # published_parsed, updated_parsed 등 여러 필드 시도
    for field in ['published_parsed', 'updated_parsed', 'created_parsed']:
        if hasattr(entry, field) and getattr(entry, field):
            try:
                import time
                return datetime(*getattr(entry, field)[:6])
            except (TypeError, ValueError):
                pass

    # 문자열에서 직접 파싱 시도
    for field in ['published', 'updated', 'created']:
        if hasattr(entry, field) and getattr(entry, field):
            try:
                return parsedate_to_datetime(getattr(entry, field))
            except (TypeError, ValueError):
                pass

    return None


def fetch_feed(feed_config: dict, days: int = 7) -> list[dict]:
    """단일 피드 수집"""
    url = feed_config.get("url", "")
    name = feed_config.get("name", url)
    category = feed_config.get("category", "general")

    if not url:
        return []

    try:
        feed = feedparser.parse(url)

        if feed.bozo and not feed.entries:
            print(f"   ⚠️  {name}: 피드 파싱 오류")
            return []

        entries = []
        cutoff_date = datetime.now() - timedelta(days=days)

        for entry in feed.entries:
            pub_date = parse_date(entry)

            # 날짜 필터링
            if pub_date and pub_date < cutoff_date:
                continue

            title = entry.get("title", "Untitled")
            link = entry.get("link", "")
            summary = entry.get("summary", "")

            # summary 정리 (HTML 태그 제거)
            import re
            summary = re.sub(r"<[^>]+>", "", summary)
            summary = re.sub(r"\s+", " ", summary).strip()
            if len(summary) > 300:
                summary = summary[:300] + "..."

            entries.append({
                "title": title,
                "link": link,
                "summary": summary,
                "published": pub_date.strftime("%Y-%m-%d %H:%M") if pub_date else "",
                "feed_name": name,
                "category": category,
            })

        return entries

    except Exception as e:
        print(f"   ⚠️  {name}: {e}")
        return []


def collect_all_feeds(feeds: list[dict], days: int = 7) -> dict[str, list[dict]]:
    """모든 피드 수집 및 카테고리별 그룹화"""
    all_entries = []

    for feed in feeds:
        name = feed.get("name", feed.get("url", "Unknown"))
        print(f"   📡 수집 중: {name}")
        entries = fetch_feed(feed, days)
        all_entries.extend(entries)
        print(f"      → {len(entries)}개 항목")

    # 카테고리별 그룹화
    by_category = {}
    for entry in all_entries:
        cat = entry.get("category", "general")
        if cat not in by_category:
            by_category[cat] = []
        by_category[cat].append(entry)

    # 각 카테고리 내에서 날짜순 정렬 (최신 먼저)
    for cat in by_category:
        by_category[cat].sort(key=lambda x: x.get("published", ""), reverse=True)

    return by_category


def build_reading_note(categorized: dict[str, list[dict]], days: int) -> str:
    """읽기 목록 노트 생성"""
    today = datetime.now().strftime("%Y-%m-%d")

    lines = [
        f"# RSS 피드 - {today}",
        "",
        f"> 최근 {days}일간 수집된 글",
        "",
    ]

    total = sum(len(entries) for entries in categorized.values())
    lines.append(f"총 {total}개 항목")
    lines.append("")

    # 카테고리 이모지 매핑
    category_emoji = {
        "tech": "💻",
        "dev": "🛠️",
        "news": "📰",
        "ai": "🤖",
        "cloud": "☁️",
        "security": "🔒",
        "design": "🎨",
        "general": "📌",
    }

    for category, entries in sorted(categorized.items()):
        emoji = category_emoji.get(category, "📌")
        lines.append(f"## {emoji} {category.title()}")
        lines.append("")

        for entry in entries[:10]:  # 카테고리당 최대 10개
            title = entry.get("title", "Untitled")
            link = entry.get("link", "")
            summary = entry.get("summary", "")
            published = entry.get("published", "")
            feed_name = entry.get("feed_name", "")

            lines.append(f"### [{title}]({link})")
            lines.append(f"- 출처: {feed_name}")
            if published:
                lines.append(f"- 날짜: {published}")
            if summary:
                lines.append(f"- {summary}")
            lines.append("")

        if len(entries) > 10:
            lines.append(f"_...외 {len(entries) - 10}개_")
            lines.append("")

    return "\n".join(lines)


def get_reading_folder_path() -> Path:
    """읽기 목록 폴더 경로"""
    vault_path = Path(CONFIG["vault"]["path"]).expanduser()
    return vault_path / "reading"


def get_existing_links() -> set[str]:
    """Obsidian reading 폴더에서 기존 글 링크들 추출"""
    import re

    reading_folder = get_reading_folder_path()
    if not reading_folder.exists():
        return set()

    existing_links = set()

    for md_file in reading_folder.glob("*.md"):
        try:
            with open(md_file, "r", encoding="utf-8") as f:
                content = f.read()

            # 마크다운 링크 추출: [title](url) 또는 <url>
            # 헤더 링크 패턴: ### [title](url)
            links = re.findall(r'\[.*?\]\((https?://[^\)]+)\)', content)
            existing_links.update(links)

        except Exception:
            pass

    return existing_links


def filter_existing_entries(
    categorized: dict[str, list[dict]],
    existing_links: set[str]
) -> tuple[dict[str, list[dict]], int]:
    """이미 존재하는 글 필터링

    Returns:
        (필터링된 결과, 건너뛴 개수)
    """
    filtered = {}
    skipped_count = 0

    for category, entries in categorized.items():
        filtered_entries = []
        for entry in entries:
            link = entry.get("link", "")
            # URL 정규화 (trailing slash 등)
            normalized_link = link.rstrip("/")

            # 기존 링크에 있는지 확인
            if any(normalized_link in existing or existing in normalized_link
                   for existing in existing_links):
                skipped_count += 1
            else:
                filtered_entries.append(entry)

        if filtered_entries:
            filtered[category] = filtered_entries

    return filtered, skipped_count


def save_reading_note(content: str, target_date: str) -> str:
    """읽기 목록 노트 저장"""
    reading_folder = get_reading_folder_path()
    reading_folder.mkdir(parents=True, exist_ok=True)

    note_path = reading_folder / f"{target_date}_rss.md"

    with open(note_path, "w", encoding="utf-8") as f:
        f.write(content)

    return str(note_path)


def send_slack_notification(categorized: dict[str, list[dict]]) -> bool:
    """Slack으로 알림 전송"""
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL")

    if not webhook_url:
        print("⚠️  SLACK_WEBHOOK_URL 환경변수가 설정되지 않았습니다.")
        return False

    total = sum(len(entries) for entries in categorized.values())
    if total == 0:
        return True

    blocks = [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": f"📰 RSS 피드 수집 ({total}개)",
                "emoji": True
            }
        },
        {"type": "divider"},
    ]

    # 카테고리별 요약
    for category, entries in sorted(categorized.items()):
        if entries:
            # 최신 3개만 표시
            sample_titles = [e["title"][:50] for e in entries[:3]]
            blocks.append({
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f"*{category.title()}* ({len(entries)}개)\n" +
                            "\n".join([f"• {t}" for t in sample_titles])
                }
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


def print_summary(categorized: dict[str, list[dict]]):
    """콘솔에 요약 출력"""
    print("\n" + "━" * 50)
    print("📰 RSS 피드 수집 결과")
    print("━" * 50)

    total = sum(len(entries) for entries in categorized.values())
    if total == 0:
        print("수집된 항목이 없습니다.")
        return

    print(f"총 {total}개 항목")
    print("")

    for category, entries in sorted(categorized.items()):
        if entries:
            print(f"{category.title()}: {len(entries)}개")
            for entry in entries[:3]:
                title = entry.get("title", "")[:50]
                print(f"  - {title}")
            if len(entries) > 3:
                print(f"  - ...외 {len(entries) - 3}개")
            print("")

    print("━" * 50)


def main():
    # 옵션 파싱
    args = sys.argv[1:]

    yes_mode = False
    slack_mode = False
    days = 7
    feed_urls = None  # --feeds 옵션으로 전달된 URL들
    skip_existing = None  # None이면 설정 파일에서 결정

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--yes", "-y"):
            yes_mode = True
            i += 1
        elif arg == "--slack":
            slack_mode = True
            i += 1
        elif arg == "--days" and i + 1 < len(args):
            days = int(args[i + 1])
            i += 2
        elif arg == "--feeds" and i + 1 < len(args):
            # 쉼표로 구분된 URL 파싱
            feed_urls = [url.strip() for url in args[i + 1].split(",") if url.strip()]
            i += 2
        elif arg == "--skip-existing":
            skip_existing = True
            i += 1
        elif arg == "--no-skip":
            skip_existing = False
            i += 1
        else:
            i += 1

    # skip_existing 결정: CLI 옵션 > 설정 파일 > 기본값(False)
    if skip_existing is None:
        rss_config = get_rss_config()
        skip_existing = rss_config.get("skip_existing", False)

    today = datetime.now().strftime("%Y-%m-%d")

    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"📰 RSS Feed Collector: {today}")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"   수집 범위: 최근 {days}일")
    print(f"   중복 방지: {'✅ 활성화' if skip_existing else '❌ 비활성화'}")
    if feed_urls:
        print(f"   소스: 옵션 지정 ({len(feed_urls)}개 URL)")

    # 피드 목록 조회
    feeds = get_feeds(override_urls=feed_urls)
    if not feeds:
        return

    print(f"   등록된 피드: {len(feeds)}개")
    print("")

    # 피드 수집
    print("📡 피드 수집 중...")
    categorized = collect_all_feeds(feeds, days)

    # 중복 필터링
    skipped_count = 0
    if skip_existing:
        print("\n🔍 중복 확인 중...")
        existing_links = get_existing_links()
        print(f"   기존 링크: {len(existing_links)}개")
        categorized, skipped_count = filter_existing_entries(categorized, existing_links)
        if skipped_count > 0:
            print(f"   ⏭️  중복 건너뜀: {skipped_count}개")

    # 콘솔 출력
    print_summary(categorized)

    total = sum(len(entries) for entries in categorized.values())
    if total == 0:
        print("\n📭 수집된 새 글이 없습니다.")
        return

    # 노트 생성
    note_content = build_reading_note(categorized, days)

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
        result_path = save_reading_note(note_content, today)
        print(f"\n✅ 저장 완료!")
        print(f"   {result_path}")
    else:
        print("\n⏭️  건너뛰었습니다.")

    # Slack 알림
    if slack_mode:
        print("\n📤 Slack 알림 전송 중...")
        if send_slack_notification(categorized):
            print("✅ Slack 알림 전송 완료!")
        else:
            print("❌ Slack 알림 전송 실패")


if __name__ == "__main__":
    main()

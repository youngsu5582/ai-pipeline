#!/usr/bin/env python3
"""
AI Pipeline - Quick Notes
=========================
빠른 메모를 _drafts에 추가하는 스크립트

Usage:
    quick "kafka consumer group rebalancing 주의"
    quick "배포 순서 고민됨 #issue"
    quick "#insight 코드리뷰하다가 깨달음"

Tags:
    #insight  - 깨달음, 인사이트
    #issue    - 고민, 문제 상황
    #todo     - 나중에 할 것
    #learned  - 오늘 배운 것
    #idea     - 아이디어
"""

import re
import sys
from datetime import datetime
from pathlib import Path

import yaml

CONFIG_PATH = Path(__file__).parent.parent / "config" / "settings.yaml"


def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


CONFIG = load_config()

# 지원하는 태그들
TAGS = {
    "#insight": "💡",
    "#issue": "🤔",
    "#todo": "📌",
    "#learned": "📚",
    "#idea": "💭",
    "#decision": "✅",
    "#blocker": "🚫",
}


def extract_tags(text: str) -> tuple[list[str], str]:
    """텍스트에서 태그 추출"""
    found_tags = []
    clean_text = text

    for tag in TAGS:
        if tag in text.lower():
            found_tags.append(tag)
            # 태그 제거 (대소문자 무관)
            clean_text = re.sub(rf"\s*{tag}\s*", " ", clean_text, flags=re.IGNORECASE)

    return found_tags, clean_text.strip()


def get_quick_note_path(target_date: str) -> Path:
    """Quick note 파일 경로"""
    vault_path = Path(CONFIG["vault"]["path"])
    drafts_folder = CONFIG["vault"].get("drafts_folder", "study/_drafts")
    return vault_path / drafts_folder / f"{target_date}_quick-notes.md"


def format_entry(text: str, tags: list[str], timestamp: str) -> str:
    """메모 엔트리 포맷팅"""
    tag_icons = " ".join(TAGS.get(tag, "") for tag in tags)
    tag_text = " ".join(tags) if tags else ""

    if tag_icons:
        return f"- [{timestamp}] {tag_icons} {text} {tag_text}\n"
    else:
        return f"- [{timestamp}] {text}\n"


def add_quick_note(text: str) -> str:
    """Quick note 추가"""
    today = datetime.now().strftime("%Y-%m-%d")
    timestamp = datetime.now().strftime("%H:%M")

    tags, clean_text = extract_tags(text)
    note_path = get_quick_note_path(today)

    entry = format_entry(clean_text, tags, timestamp)

    if note_path.exists():
        # 기존 파일에 추가
        with open(note_path, "r", encoding="utf-8") as f:
            content = f.read()

        # "## Notes" 섹션 찾아서 추가
        if "## Notes" in content:
            # Notes 섹션 끝에 추가
            parts = content.split("## Notes")
            if len(parts) == 2:
                header, notes = parts
                content = f"{header}## Notes{notes.rstrip()}\n{entry}"
        else:
            content = content.rstrip() + "\n" + entry
    else:
        # 새 파일 생성
        note_path.parent.mkdir(parents=True, exist_ok=True)
        content = f"""---
title: Quick Notes - {today}
date: {today}
category: quick
tags: [quick-notes, daily]
---

# Quick Notes - {today}

빠른 메모 모음. Weekly/Monthly 리뷰 시 참고됨.

## Notes
{entry}"""

    with open(note_path, "w", encoding="utf-8") as f:
        f.write(content)

    return str(note_path)


def show_today_notes() -> None:
    """오늘의 quick notes 보여주기"""
    today = datetime.now().strftime("%Y-%m-%d")
    note_path = get_quick_note_path(today)

    if note_path.exists():
        with open(note_path, "r", encoding="utf-8") as f:
            content = f.read()
        print(f"\n📝 오늘의 Quick Notes ({today})")
        print("━" * 40)
        # Notes 섹션만 출력
        if "## Notes" in content:
            notes_section = content.split("## Notes")[1]
            print(notes_section.strip())
        print("━" * 40)
    else:
        print(f"\n📭 오늘({today}) 작성된 quick note가 없습니다.")


def show_help():
    """도움말 출력"""
    print("Usage: quick <메모 내용>")
    print("\n사용 가능한 태그:")
    for tag, icon in TAGS.items():
        print(f"  {icon} {tag}")
    print("\n예시:")
    print('  quick "kafka rebalancing 이슈 발견"')
    print('  quick "#issue 배포 순서 어떻게 할지 고민"')
    print('  quick "#insight 코드리뷰하다가 깨달음"')
    print("\n옵션:")
    print("  --show   오늘의 quick notes 보기")
    print("  --help   이 도움말")


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("--help", "-h"):
        show_help()
        return

    if sys.argv[1] == "--show":
        show_today_notes()
        return

    text = " ".join(sys.argv[1:])
    result_path = add_quick_note(text)

    tags, clean_text = extract_tags(text)
    tag_icons = " ".join(TAGS.get(tag, "") for tag in tags)

    print(f"✅ Quick note 추가됨")
    if tag_icons:
        print(f"   {tag_icons} {clean_text}")
    else:
        print(f"   {clean_text}")
    print(f"   → {result_path}")


if __name__ == "__main__":
    main()

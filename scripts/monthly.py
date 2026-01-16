#!/usr/bin/env python3
"""
AI Pipeline - Monthly Review
=============================
월간 주간 회고들을 종합하여 월간 성장 리포트 생성

Usage:
    python monthly.py           # 이번 달
    python monthly.py 2026-01   # 특정 월
"""

import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

import yaml

CONFIG_PATH = Path(__file__).parent.parent / "config" / "settings.yaml"


def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


CONFIG = load_config()


@dataclass
class MonthlyInputs:
    year_month: str  # 2026-01
    weekly_reviews: list[dict]
    daily_notes: list[dict]
    quick_notes: list[dict]
    github_activities: list[dict]


class GeminiClient:
    """Google Gemini API 클라이언트"""

    def __init__(self):
        try:
            from google import genai
        except ImportError:
            print("google-genai 패키지가 설치되지 않았습니다.")
            print("pip install google-genai")
            sys.exit(1)

        api_key = os.environ.get("GOOGLE_API_KEY")
        if not api_key:
            print("GOOGLE_API_KEY 환경변수가 설정되지 않았습니다.")
            sys.exit(1)

        self.client = genai.Client(api_key=api_key)
        self.model_name = CONFIG["llm"]["gemini"]["model"]

    def analyze(self, prompt: str) -> dict:
        from google.genai import types

        response = self.client.models.generate_content(
            model=self.model_name,
            contents=prompt,
            config=types.GenerateContentConfig(
                temperature=0.3,
                response_mime_type="application/json",
            ),
        )

        raw_text = response.text or ""
        try:
            return json.loads(raw_text)
        except json.JSONDecodeError:
            match = re.search(r"\{[\s\S]*\}", raw_text)
            if match:
                return json.loads(match.group())
            raise


def parse_month(month_str: Optional[str]) -> tuple[int, int]:
    """월 문자열 파싱 (YYYY-MM 형식)"""
    if not month_str:
        now = datetime.now()
        return now.year, now.month
    try:
        parts = month_str.split("-")
        return int(parts[0]), int(parts[1])
    except (ValueError, IndexError):
        print("월 형식이 올바르지 않습니다. 예: 2026-01")
        sys.exit(1)


def collect_weekly_reviews(year: int, month: int) -> list[dict]:
    """해당 월의 주간 회고 수집"""
    vault_path = Path(CONFIG["vault"]["path"])
    daily_folder = CONFIG["vault"].get("daily_folder", "DAILY")
    daily_path = vault_path / daily_folder

    reviews = []
    if not daily_path.exists():
        return reviews

    # YYYY-WXX-회고.md 형식 찾기
    for file_path in sorted(daily_path.glob("*-W*-회고.md")):
        # 파일명에서 주차 정보 추출
        match = re.match(r"(\d{4})-W(\d{2})-회고\.md", file_path.name)
        if not match:
            continue

        week_year = int(match.group(1))
        week_num = int(match.group(2))

        # 해당 주가 이 달에 속하는지 확인
        # 대략적 계산: 주차 * 7일이 해당 월에 포함되는지
        from datetime import timedelta

        # ISO 주차의 첫 날 계산
        jan4 = datetime(week_year, 1, 4)
        week_start = jan4 - timedelta(days=jan4.isoweekday() - 1)
        week_start += timedelta(weeks=week_num - 1)

        if week_start.year == year and week_start.month == month:
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()
            reviews.append(
                {
                    "path": file_path,
                    "week_id": f"{week_year}-W{week_num:02d}",
                    "content": content,
                }
            )
        # 주의 시작이 이전 달이지만 끝이 이번 달인 경우도 포함
        elif (
            week_start.year == year
            and week_start.month == month - 1
            and (week_start + timedelta(days=6)).month == month
        ):
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()
            reviews.append(
                {
                    "path": file_path,
                    "week_id": f"{week_year}-W{week_num:02d}",
                    "content": content,
                }
            )

    return reviews


def collect_daily_notes(year: int, month: int) -> list[dict]:
    """해당 월의 Daily Notes 수집 (고민거리, 생각 섹션)"""
    vault_path = Path(CONFIG["vault"]["path"])
    daily_folder = CONFIG["vault"].get("daily_folder", "DAILY")
    daily_path = vault_path / daily_folder

    notes = []
    if not daily_path.exists():
        return notes

    month_prefix = f"{year}-{month:02d}"
    for file_path in sorted(daily_path.glob(f"{month_prefix}-*.md")):
        # 회고 파일 제외
        if "회고" in file_path.name:
            continue

        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        # 고민거리와 생각 섹션 추출
        concerns = ""
        thoughts = ""

        concern_match = re.search(
            r"## 🤔 고민거리\s*\n(.*?)(?=\n## |\Z)", content, re.DOTALL
        )
        if concern_match:
            concerns = concern_match.group(1).strip()

        thought_match = re.search(
            r"## 📝 오늘의 생각\s*\n(.*?)(?=\n## |\Z)", content, re.DOTALL
        )
        if thought_match:
            thoughts = thought_match.group(1).strip()

        if concerns or thoughts:
            notes.append(
                {
                    "date": file_path.stem,
                    "concerns": concerns,
                    "thoughts": thoughts,
                }
            )

    return notes


def collect_quick_notes(year: int, month: int) -> list[dict]:
    """해당 월의 Quick Notes 수집"""
    vault_path = Path(CONFIG["vault"]["path"])
    drafts_folder = CONFIG["vault"].get("drafts_folder", "study/_drafts")
    drafts_path = vault_path / drafts_folder

    notes = []
    if not drafts_path.exists():
        return notes

    month_prefix = f"{year}-{month:02d}"
    for file_path in sorted(drafts_path.glob(f"{month_prefix}-*_quick-notes.md")):
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        # Notes 섹션 추출
        notes_match = re.search(r"## Notes\s*\n(.*?)(?=\Z)", content, re.DOTALL)
        if notes_match:
            notes.append(
                {
                    "date": file_path.stem.replace("_quick-notes", ""),
                    "content": notes_match.group(1).strip(),
                }
            )

    return notes


def extract_github_summary(year: int, month: int) -> list[dict]:
    """Daily Notes에서 GitHub 활동 요약 추출"""
    vault_path = Path(CONFIG["vault"]["path"])
    daily_folder = CONFIG["vault"].get("daily_folder", "DAILY")
    daily_path = vault_path / daily_folder

    activities = []
    if not daily_path.exists():
        return activities

    month_prefix = f"{year}-{month:02d}"
    for file_path in sorted(daily_path.glob(f"{month_prefix}-*.md")):
        if "회고" in file_path.name:
            continue

        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        # GitHub 활동 섹션 추출
        github_match = re.search(
            r"## 🐙 GitHub 활동\s*\n(.*?)(?=\n## |\Z)", content, re.DOTALL
        )
        if github_match:
            activities.append(
                {
                    "date": file_path.stem,
                    "content": github_match.group(1).strip(),
                }
            )

    return activities


def build_prompt(inputs: MonthlyInputs) -> str:
    """LLM 프롬프트 생성"""
    weekly_block = []
    for review in inputs.weekly_reviews:
        weekly_block.append(f"### {review['week_id']}\n```\n{review['content']}\n```")

    daily_block = []
    for note in inputs.daily_notes:
        if note["concerns"]:
            daily_block.append(f"### {note['date']} 고민\n{note['concerns']}")
        if note["thoughts"]:
            daily_block.append(f"### {note['date']} 생각\n{note['thoughts']}")

    quick_block = []
    for note in inputs.quick_notes:
        quick_block.append(f"### {note['date']}\n{note['content']}")

    github_block = []
    for activity in inputs.github_activities:
        github_block.append(f"### {activity['date']}\n{activity['content']}")

    weekly_text = "\n\n".join(weekly_block) if weekly_block else "없음"
    daily_text = "\n\n".join(daily_block) if daily_block else "없음"
    quick_text = "\n\n".join(quick_block) if quick_block else "없음"
    github_text = "\n\n".join(github_block) if github_block else "없음"

    return f"""당신은 개발자의 월간 성장을 분석하는 전문가입니다.

아래 자료를 분석해서 월간 성장 리포트를 JSON으로 반환하세요.

분석 시 중요한 점:
1. 단순 "뭘 했다"가 아닌 "어떤 고민을 했고, 무엇을 배웠는지" 맥락 중심
2. 기술적 성장과 함께 사고/판단력의 성장도 포착
3. 반복되는 고민이나 패턴을 발견하면 언급
4. 다음 달을 위한 구체적 제안

반환 JSON 형식:
{{
  "executive_summary": "한 문장으로 이번 달을 정의",
  "growth_areas": [
    {{
      "category": "카테고리명 (기술/사고방식/협업 등)",
      "title": "성장 영역 제목",
      "description": "구체적 설명",
      "evidence": ["근거1", "근거2"]
    }}
  ],
  "challenges_faced": [
    {{
      "challenge": "직면한 도전/고민",
      "context": "맥락 설명",
      "resolution": "해결 여부와 방법 (미해결이면 null)",
      "learning": "배운 점"
    }}
  ],
  "recurring_patterns": [
    {{
      "pattern": "반복되는 패턴",
      "frequency": "빈도",
      "suggestion": "개선 제안"
    }}
  ],
  "statistics": {{
    "weekly_reviews": {len(inputs.weekly_reviews)},
    "daily_notes": {len(inputs.daily_notes)},
    "quick_notes": {len(inputs.quick_notes)},
    "github_active_days": {len(inputs.github_activities)},
    "top_topics": ["주제1", "주제2", "주제3"]
  }},
  "next_month_focus": [
    {{
      "area": "집중 영역",
      "why": "이유",
      "how": "구체적 방법"
    }}
  ],
  "memorable_moments": ["인상적인 순간/인사이트 1", "2", "3"]
}}

월: {inputs.year_month}

## 주간 회고들
{weekly_text}

## Daily Notes (고민/생각)
{daily_text}

## Quick Notes
{quick_text}

## GitHub 활동
{github_text}
"""


def build_monthly_md(year_month: str, analysis: dict) -> str:
    """마크다운 리포트 생성"""
    lines = [
        f"# {year_month} 월간 성장 리포트",
        "",
        f"> {analysis.get('executive_summary', '')}",
        "",
    ]

    # 통계
    stats = analysis.get("statistics", {})
    lines.extend(
        [
            "## 📊 이번 달 숫자",
            "",
            f"| 항목 | 수치 |",
            f"|------|------|",
            f"| 주간 회고 | {stats.get('weekly_reviews', 0)} |",
            f"| Daily Notes | {stats.get('daily_notes', 0)} |",
            f"| Quick Notes | {stats.get('quick_notes', 0)} |",
            f"| GitHub 활동일 | {stats.get('github_active_days', 0)} |",
            "",
            f"**주요 주제**: {', '.join(stats.get('top_topics', []))}",
            "",
        ]
    )

    # 성장 영역
    growth_areas = analysis.get("growth_areas", [])
    if growth_areas:
        lines.extend(["## 🌱 성장 영역", ""])
        for area in growth_areas:
            lines.append(f"### {area.get('category', '')} - {area.get('title', '')}")
            lines.append(f"{area.get('description', '')}")
            lines.append("")
            for evidence in area.get("evidence", []):
                lines.append(f"- {evidence}")
            lines.append("")

    # 직면한 도전
    challenges = analysis.get("challenges_faced", [])
    if challenges:
        lines.extend(["## 🤔 직면한 도전", ""])
        for challenge in challenges:
            lines.append(f"### {challenge.get('challenge', '')}")
            lines.append(f"**맥락**: {challenge.get('context', '')}")
            resolution = challenge.get("resolution")
            if resolution:
                lines.append(f"**해결**: {resolution}")
            else:
                lines.append("**상태**: 진행 중")
            lines.append(f"**배운 점**: {challenge.get('learning', '')}")
            lines.append("")

    # 반복 패턴
    patterns = analysis.get("recurring_patterns", [])
    if patterns:
        lines.extend(["## 🔄 반복되는 패턴", ""])
        for pattern in patterns:
            lines.append(f"- **{pattern.get('pattern', '')}** ({pattern.get('frequency', '')})")
            lines.append(f"  - 제안: {pattern.get('suggestion', '')}")
        lines.append("")

    # 인상적인 순간
    moments = analysis.get("memorable_moments", [])
    if moments:
        lines.extend(["## ✨ 인상적인 순간", ""])
        for moment in moments:
            lines.append(f"- {moment}")
        lines.append("")

    # 다음 달 집중
    next_focus = analysis.get("next_month_focus", [])
    if next_focus:
        lines.extend(["## 🎯 다음 달 Focus", ""])
        for focus in next_focus:
            lines.append(f"### {focus.get('area', '')}")
            lines.append(f"- **Why**: {focus.get('why', '')}")
            lines.append(f"- **How**: {focus.get('how', '')}")
            lines.append("")

    return "\n".join(lines)


def main():
    # 월 파라미터 처리
    month_arg = sys.argv[1] if len(sys.argv) > 1 else None
    year, month = parse_month(month_arg)
    year_month = f"{year}-{month:02d}"

    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"📆 Monthly Review: {year_month}")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

    # 데이터 수집
    print("\n📡 데이터 수집 중...")
    weekly_reviews = collect_weekly_reviews(year, month)
    daily_notes = collect_daily_notes(year, month)
    quick_notes = collect_quick_notes(year, month)
    github_activities = extract_github_summary(year, month)

    print(f"   주간 회고: {len(weekly_reviews)}")
    print(f"   Daily Notes: {len(daily_notes)}")
    print(f"   Quick Notes: {len(quick_notes)}")
    print(f"   GitHub 활동일: {len(github_activities)}")

    if not weekly_reviews and not daily_notes and not quick_notes:
        print(f"\n📭 {year_month}의 데이터가 없습니다.")
        return

    # LLM 분석
    print("\n🤖 AI 분석 중...")
    inputs = MonthlyInputs(
        year_month=year_month,
        weekly_reviews=weekly_reviews,
        daily_notes=daily_notes,
        quick_notes=quick_notes,
        github_activities=github_activities,
    )

    prompt = build_prompt(inputs)
    llm = GeminiClient()
    analysis = llm.analyze(prompt)

    # 리포트 생성
    monthly_md = build_monthly_md(year_month, analysis)

    # 미리보기
    print("\n" + "━" * 60)
    print("📋 월간 리포트 미리보기")
    print("━" * 60)
    print(monthly_md)
    print("━" * 60)

    # 저장
    vault_path = Path(CONFIG["vault"]["path"])
    daily_folder = CONFIG["vault"].get("daily_folder", "DAILY")
    monthly_path = vault_path / daily_folder / f"{year_month}-월간리포트.md"

    try:
        choice = input("\n저장할까요? [Y/n]: ").strip().lower()
    except EOFError:
        choice = "y"

    if choice in ["", "y", "yes"]:
        monthly_path.parent.mkdir(parents=True, exist_ok=True)
        with open(monthly_path, "w", encoding="utf-8") as f:
            f.write(monthly_md)
        print(f"\n✅ 저장 완료!")
        print(f"   {monthly_path}")
    else:
        print("\n⏭️  건너뛰었습니다.")


if __name__ == "__main__":
    main()

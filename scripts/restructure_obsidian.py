#!/usr/bin/env python3
"""
Obsidian Study 폴더 재구조화 스크립트
=====================================
기존 폴더 구조를 tech/, projects/, resources/, journal/ 체계로 재구조화

구조:
study/
├── _drafts/          # 시스템 (유지)
├── _quizzes/         # 시스템 (유지)
├── _inbox/           # 시스템 (Inbox → _inbox)
│
├── tech/             # 기술 스택
│   ├── java/
│   ├── spring/
│   ├── kafka/
│   ├── postgresql/   # DB 내용 이동
│   ├── redis/
│   ├── rabbitmq/
│   ├── elasticsearch/
│   ├── docker/
│   ├── aws/
│   ├── shell/
│   ├── web/
│   ├── network/
│   └── ai/
│
├── projects/         # 프로젝트별 학습
│   └── aicreation/
│
├── resources/        # 학습 자원
│   ├── books/
│   ├── courses/
│   └── articles/
│
└── journal/          # 일지
    ├── daily/
    ├── weekly/
    └── meetings/
"""

import shutil
from pathlib import Path

STUDY_PATH = Path.home() / "Documents" / "Obsidian" / "study"  # 환경에 맞게 수정

# 폴더 매핑 (old → new)
FOLDER_MAPPINGS = {
    # 시스템 폴더
    "Inbox": "_inbox",

    # 기술 스택 → tech/
    "AI": "tech/ai",
    "aws": "tech/aws",
    "DB": "tech/postgresql",
    "Docker": "tech/docker",
    "Elasticsearch": "tech/elasticsearch",
    "Java": "tech/java",
    "kafka": "tech/kafka",
    "network": "tech/network",
    "RabbitMQ": "tech/rabbitmq",
    "Redis": "tech/redis",
    "shell": "tech/shell",
    "spring": "tech/spring",
    "web": "tech/web",

    # 학습 자원 → resources/
    "books": "resources/books",
    "English": "resources/courses/english",
    "Tools": "resources/tools",

    # 일지 → journal/
    "일일 계획": "journal/daily",
    "회의 노트": "journal/meetings",
    "꾸준한 학습": "journal/weekly",
}

# 루트 파일 매핑 (파일명 → 대상 폴더)
ROOT_FILE_MAPPINGS = {
    "Raft 알고리즘.md": "tech/distributed",
    "JWK.md": "tech/security",
    "Basic 인증.md": "tech/security",
    "XML.md": "tech/web",
    "Java Null Safety - gspecify and Neway.md": "tech/java",
    "라인 개발자 - 2.md": "resources/articles",
    "사고치지 않는 신입 개발자.md": "resources/articles",
    "개발자라면 꼭! 알아야 할 AI 기술 활용법 영상에 대한 정리 및 간단한 사담.md": "resources/articles",
    ".md": "_inbox",  # 빈 파일명
}


def create_new_structure():
    """새 폴더 구조 생성"""
    new_folders = [
        "_inbox",
        "tech/java",
        "tech/spring",
        "tech/kafka",
        "tech/postgresql",
        "tech/redis",
        "tech/rabbitmq",
        "tech/elasticsearch",
        "tech/docker",
        "tech/aws",
        "tech/shell",
        "tech/web",
        "tech/network",
        "tech/ai",
        "tech/security",
        "tech/distributed",
        "projects/aicreation/specs",
        "projects/aicreation/implementation",
        "projects/aicreation/learning",
        "projects/aicreation/issues",
        "projects/aicreation/testing",
        "resources/books",
        "resources/courses",
        "resources/articles",
        "resources/tools",
        "journal/daily",
        "journal/weekly",
        "journal/meetings",
    ]

    for folder in new_folders:
        path = STUDY_PATH / folder
        path.mkdir(parents=True, exist_ok=True)
        print(f"📁 Created: {folder}")


def move_folders():
    """기존 폴더 이동"""
    for old_name, new_name in FOLDER_MAPPINGS.items():
        old_path = STUDY_PATH / old_name
        new_path = STUDY_PATH / new_name

        if not old_path.exists():
            print(f"⏭️  Skip (not found): {old_name}")
            continue

        if old_path == new_path:
            print(f"⏭️  Skip (same path): {old_name}")
            continue

        # 대상 폴더 생성
        new_path.mkdir(parents=True, exist_ok=True)

        # 내용 이동 (폴더 내 파일들)
        for item in old_path.iterdir():
            if item.name == ".DS_Store":
                continue
            dest = new_path / item.name
            if dest.exists():
                print(f"⚠️  Exists, skip: {item.name}")
                continue
            shutil.move(str(item), str(dest))
            print(f"✅ {old_name}/{item.name} → {new_name}/{item.name}")

        # 빈 폴더 삭제
        try:
            old_path.rmdir()
            print(f"🗑️  Removed empty: {old_name}")
        except OSError:
            print(f"⚠️  Not empty, kept: {old_name}")


def move_root_files():
    """루트 MD 파일 이동"""
    for filename, target_folder in ROOT_FILE_MAPPINGS.items():
        source = STUDY_PATH / filename
        if not source.exists():
            continue

        dest_folder = STUDY_PATH / target_folder
        dest_folder.mkdir(parents=True, exist_ok=True)
        dest = dest_folder / filename

        if dest.exists():
            print(f"⚠️  Exists, skip: {filename}")
            continue

        shutil.move(str(source), str(dest))
        print(f"✅ {filename} → {target_folder}/")


def main():
    print("━" * 50)
    print("📂 Obsidian Study 폴더 재구조화")
    print("━" * 50)

    print("\n[1/3] 새 폴더 구조 생성...")
    create_new_structure()

    print("\n[2/3] 기존 폴더 이동...")
    move_folders()

    print("\n[3/3] 루트 파일 이동...")
    move_root_files()

    print("\n" + "━" * 50)
    print("✅ 재구조화 완료!")
    print("━" * 50)


if __name__ == "__main__":
    main()

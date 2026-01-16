"""
AI Pipeline - Configuration Module
===================================
설정 파일 및 환경변수 로딩을 담당하는 모듈

설정 우선순위:
1. 환경변수 (최우선)
2. config/settings.local.yaml (개인 설정)
3. config/settings.yaml (기본 설정)
4. config/settings.example.yaml (템플릿)
"""

import os
import sys
from pathlib import Path
from typing import Any, Optional

import yaml

# 프로젝트 루트 경로
PROJECT_ROOT = Path(__file__).parent.parent
CONFIG_DIR = PROJECT_ROOT / "config"


def _expand_path(path: str) -> str:
    """경로 확장 (~, 환경변수)"""
    return os.path.expandvars(os.path.expanduser(path))


def _load_yaml_config() -> dict:
    """YAML 설정 파일 로드 (우선순위 적용)"""
    config_files = [
        CONFIG_DIR / "settings.local.yaml",  # 개인 설정 (최우선)
        CONFIG_DIR / "settings.yaml",         # 기본 설정
        CONFIG_DIR / "settings.example.yaml", # 템플릿 (fallback)
    ]

    for config_file in config_files:
        if config_file.exists():
            with open(config_file, "r", encoding="utf-8") as f:
                config = yaml.safe_load(f) or {}
                config["_loaded_from"] = str(config_file)
                return config

    print("⚠️  설정 파일을 찾을 수 없습니다.")
    print("   cp config/settings.example.yaml config/settings.local.yaml")
    sys.exit(1)


def _apply_env_overrides(config: dict) -> dict:
    """환경변수로 설정 덮어쓰기"""
    env_mappings = {
        # Vault 설정
        "AI_VAULT_PATH": ("vault", "path"),
        "AI_TARGET_FOLDER": ("vault", "target_folder"),
        "AI_DRAFTS_FOLDER": ("vault", "drafts_folder"),
        "AI_DAILY_FOLDER": ("vault", "daily_folder"),
        "AI_QUIZZES_FOLDER": ("vault", "quizzes_folder"),
        # LLM 설정
        "AI_LLM_PROVIDER": ("llm", "provider"),
        # Pipeline 설정
        "AI_RAW_LOGS_DIR": ("pipeline", "raw_logs_dir"),
        "AI_PROCESSED_LOGS_DIR": ("pipeline", "processed_logs_dir"),
    }

    for env_var, path in env_mappings.items():
        value = os.environ.get(env_var)
        if value:
            # 중첩 딕셔너리에 값 설정
            d = config
            for key in path[:-1]:
                d = d.setdefault(key, {})
            d[path[-1]] = value

    # GitHub repos (콤마로 구분된 환경변수)
    github_repos = os.environ.get("AI_GITHUB_REPOS")
    if github_repos:
        config.setdefault("github", {})["repos"] = [
            r.strip() for r in github_repos.split(",") if r.strip()
        ]

    return config


def _expand_paths(config: dict) -> dict:
    """경로 설정 확장"""
    # Vault 경로
    if "vault" in config:
        if "path" in config["vault"]:
            config["vault"]["path"] = _expand_path(config["vault"]["path"])

    # Pipeline 경로
    if "pipeline" in config:
        if "raw_logs_dir" in config["pipeline"]:
            config["pipeline"]["raw_logs_dir"] = _expand_path(
                config["pipeline"]["raw_logs_dir"]
            )
        if "processed_logs_dir" in config["pipeline"]:
            config["pipeline"]["processed_logs_dir"] = _expand_path(
                config["pipeline"]["processed_logs_dir"]
            )

    # GitHub repos 경로
    if "github" in config and "repos" in config["github"]:
        config["github"]["repos"] = [
            _expand_path(r) for r in config["github"]["repos"]
        ]

    return config


def load_config() -> dict:
    """설정 로드 (캐싱)"""
    if not hasattr(load_config, "_cache"):
        config = _load_yaml_config()
        config = _apply_env_overrides(config)
        config = _expand_paths(config)
        load_config._cache = config
    return load_config._cache


def get(key: str, default: Any = None) -> Any:
    """설정 값 조회 (dot notation 지원)

    예: get("vault.path"), get("llm.provider")
    """
    config = load_config()
    keys = key.split(".")
    value = config
    for k in keys:
        if isinstance(value, dict):
            value = value.get(k)
        else:
            return default
        if value is None:
            return default
    return value


def get_vault_path() -> Path:
    """Vault 경로 반환"""
    return Path(get("vault.path"))


def get_drafts_path() -> Path:
    """Drafts 폴더 경로 반환"""
    return get_vault_path() / get("vault.drafts_folder", "study/_drafts")


def get_daily_path() -> Path:
    """Daily 폴더 경로 반환"""
    return get_vault_path() / get("vault.daily_folder", "DAILY")


def get_quizzes_path() -> Path:
    """Quizzes 폴더 경로 반환"""
    return get_vault_path() / get("vault.quizzes_folder", "study/_quizzes")


def get_llm_provider() -> str:
    """LLM provider 반환"""
    return get("llm.provider", "gemini")


def get_llm_model() -> str:
    """현재 LLM 모델명 반환"""
    provider = get_llm_provider()
    return get(f"llm.{provider}.model", "gemini-3-flash-preview")


def get_github_repos() -> list[str]:
    """GitHub 저장소 경로 목록 반환"""
    return get("github.repos", [])


def validate_config() -> list[str]:
    """설정 유효성 검사, 오류 목록 반환"""
    errors = []
    config = load_config()

    # Vault 경로 확인
    vault_path = get_vault_path()
    if not vault_path.exists():
        errors.append(f"Vault 경로가 존재하지 않습니다: {vault_path}")

    # LLM API 키 확인
    provider = get_llm_provider()
    api_key_env = {
        "gemini": "GOOGLE_API_KEY",
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
    }.get(provider)

    if api_key_env and not os.environ.get(api_key_env):
        errors.append(f"{api_key_env} 환경변수가 설정되지 않았습니다.")

    return errors


def print_config_summary():
    """설정 요약 출력"""
    config = load_config()
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print("🔧 AI Pipeline 설정")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"   설정 파일: {config.get('_loaded_from', 'unknown')}")
    print(f"   Vault: {get_vault_path()}")
    print(f"   Drafts: {get('vault.drafts_folder')}")
    print(f"   Daily: {get('vault.daily_folder')}")
    print(f"   LLM: {get_llm_provider()} ({get_llm_model()})")
    print(f"   GitHub Repos: {len(get_github_repos())}개")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")


# 모듈 로드 시 설정 미리 로드
CONFIG = load_config()


if __name__ == "__main__":
    # 직접 실행 시 설정 확인
    print_config_summary()
    errors = validate_config()
    if errors:
        print("\n⚠️  설정 오류:")
        for error in errors:
            print(f"   - {error}")
    else:
        print("\n✅ 설정이 유효합니다.")

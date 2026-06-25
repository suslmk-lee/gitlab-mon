#!/usr/bin/env python3
"""Quantum Hub — NotebookLM 회의록 생성 헬퍼.

로컬 오디오 파일을 NotebookLM에 업로드해 회의록(전사 기반)을 생성하고,
임시로 만든 노트북은 분석 후 삭제한다(노트북이 남지 않음).

사용법:
    python3 nlm_minutes.py <audio_path> [notebook_name] [wait_timeout_sec]

표준출력으로 JSON 한 줄을 반환한다: {"content": "...", "error": "..."}
notebooklm-py(https://github.com/teng-lin/notebooklm-py)와 `notebooklm login`이 필요하다.
"""

import asyncio
import json
import sys
from pathlib import Path

PROMPT = """이 음성 파일은 회의 녹음입니다. 한국어로 아래 형식의 회의록을 마크다운으로 작성하세요.
원문(음성)에 없는 내용은 절대 지어내지 마세요.

## 회의 요약
핵심을 3~5문장으로 요약.

## 주요 안건 및 논의
각 안건별로 논의된 내용을 구체적으로 정리.

## 결정 사항
- 회의에서 결정된 사항을 불릿으로 정리.

## 액션 아이템
- [ ] 담당자 | 내용 | 기한 (파악 가능한 경우)

## 대화 흐름
시간 순서대로 주요 발언과 논의를 가능한 한 자세히 정리하세요. 화자 구분이 가능하면 표기하세요.
"""


def emit(content: str = "", error: str = "") -> None:
    """JSON 한 줄을 출력하고 종료한다."""
    print(json.dumps({"content": content, "error": error}, ensure_ascii=False))
    sys.exit(0 if not error else 1)


async def analyze(audio_path: str, notebook_name: str, wait_timeout: float) -> str:
    from notebooklm import NotebookLMClient  # 호출 전 main에서 설치 여부 확인

    async with await NotebookLMClient.from_storage() as client:
        nb = await client.notebooks.create(notebook_name)
        try:
            await client.sources.add_file(
                nb.id, Path(audio_path), wait=True, wait_timeout=wait_timeout
            )
            result = await client.chat.ask(nb.id, PROMPT)
            return (getattr(result, "answer", "") or "").strip()
        finally:
            # 임시 노트북 삭제(실패해도 결과 출력은 유지)
            try:
                await client.notebooks.delete(nb.id)
            except Exception:
                pass


def main() -> None:
    if len(sys.argv) < 2:
        emit(error="오디오 경로가 필요합니다")

    audio = sys.argv[1]
    name = sys.argv[2] if len(sys.argv) > 2 else "QuantumHub_회의록"
    try:
        wait_timeout = float(sys.argv[3]) if len(sys.argv) > 3 else 1200.0
    except ValueError:
        wait_timeout = 1200.0

    if not Path(audio).exists():
        emit(error=f"파일을 찾을 수 없습니다: {audio}")

    try:
        import notebooklm  # noqa: F401
    except Exception as exc:  # 미설치
        emit(error=f"notebooklm-py 미설치 — 'pip install notebooklm-py[browser]' 필요 ({exc})")

    try:
        content = asyncio.run(analyze(audio, name, wait_timeout))
    except Exception as exc:
        emit(error=f"NotebookLM 처리 실패: {exc} — 로그인 필요 시 'notebooklm login'을 실행하세요")

    if not content:
        emit(error="NotebookLM이 빈 결과를 반환했습니다")
    emit(content=content)


if __name__ == "__main__":
    main()

"""
Собирает docs/settings-orlyatnik-defaults.json из export const kb в src/config.ts.
Учитывает конкатенацию '...' + `...`, пропускает строки при поиске конца блока kb
(иначе } в ${...} обрезает объект), UTF-8 без искажений.
Запуск из корня: python scripts/build_settings_json.py
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "src" / "config.ts"
OUT = ROOT / "docs" / "settings-orlyatnik-defaults.json"

FIELD_PROMPTS = {
    "fio": "Супер! Давай знакомиться. Напиши своё ФИО полностью, как в паспорте — это нужно для базы отдыха.",
    "city": "Из какого ты города?",
    "dob": "Дата рождения? (можно в любом формате)",
    "companions": "С кем едешь? (один/одна, вдвоём, думаешь — напиши как есть)",
    "phone": "Номер телефона для связи?",
    "comment": "Есть ли особенности или аллергии, о которых важно знать? Если нет — напиши «нет» или «—».",
    "shift": "Какая смена? (можно выбрать из списка или написать дату)",
}

ORLYATNIK_PAYMENT_INSTRUCTION = (
    "Внеси задаток по реквизитам ниже. В комментарии к переводу ничего указывать не нужно. "
    "После перевода пришли чек (скрин или PDF) в этот чат."
)


def default_manager_tg_username(config_text: str) -> str:
    m = re.search(
        r"MANAGER_TG_USERNAME:\s*process\.env\.MANAGER_TG_USERNAME\s*\?\?\s*'([^']*)'",
        config_text,
    )
    return m.group(1) if m else "krisis_pr"


def extract_kb_block(text: str) -> str:
    """Баланс { } только вне строк/шаблонов — иначе } из ${...} ломает границу."""
    m = re.search(r"export const kb\s*=\s*\{", text)
    if not m:
        raise SystemExit("export const kb not found")
    start = m.end() - 1
    assert text[start] == "{"
    depth = 0
    i = start
    n = len(text)
    while i < n:
        c = text[i]
        if c == "'":
            ni, _ = read_ts_single_quoted(text, i)
            i = ni
            continue
        if c == "`":
            ni, _ = read_ts_template(text, i)
            i = ni
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
        i += 1
    raise SystemExit("unclosed kb block")


def read_ts_single_quoted(text: str, i: int) -> tuple[int, str]:
    """i указывает на открывающую '. Возвращает (позиция после закрывающей ', значение)."""
    assert text[i] == "'"
    i += 1
    parts: list[str] = []
    while i < len(text):
        c = text[i]
        if c == "\\":
            if i + 1 >= len(text):
                break
            n = text[i + 1]
            esc = {"n": "\n", "r": "\r", "t": "\t", "'": "'", '"': '"', "\\": "\\"}
            parts.append(esc.get(n, n))
            i += 2
            continue
        if c == "'":
            return i + 1, "".join(parts)
        parts.append(c)
        i += 1
    raise ValueError("unterminated string")


def read_ts_template(text: str, i: int) -> tuple[int, str]:
    """i на символе `. Поддерживает ${...} как неразрывный блок."""
    assert text[i] == "`"
    i += 1
    parts: list[str] = []
    while i < len(text):
        c = text[i]
        if c == "\\":
            if i + 1 < len(text):
                parts.append(text[i + 1])
                i += 2
                continue
        if c == "`":
            return i + 1, "".join(parts)
        if c == "$" and i + 1 < len(text) and text[i + 1] == "{":
            j = i + 2
            depth = 1
            while j < len(text) and depth:
                if text[j] == "{":
                    depth += 1
                elif text[j] == "}":
                    depth -= 1
                j += 1
            parts.append(text[i:j])
            i = j
            continue
        parts.append(c)
        i += 1
    raise ValueError("unterminated template")


def read_value(text: str, i: int) -> tuple[int, str | bool | int]:
    while i < len(text) and text[i] in " \t\n\r":
        i += 1
    if i >= len(text):
        raise ValueError("EOF")
    if text[i] == "'":
        ni, val = read_ts_single_quoted(text, i)
        return ni, val
    if text[i] == "`":
        ni, val = read_ts_template(text, i)
        return ni, val
    if text.startswith("false", i):
        return i + 5, False
    if text.startswith("true", i):
        return i + 4, True
    m = re.match(r"\d[\d_]*", text[i:])
    if m:
        num = int(m.group(0).replace("_", ""))
        return i + len(m.group(0)), num
    raise ValueError(f"unknown literal at {i}: {text[i : i + 40]!r}")


def read_kb_field_value(text: str, i: int) -> tuple[int, str | bool | int]:
    """Значение поля: литерал или цепочка '...' + `...` + '...' (как в config.ts)."""
    j = i
    while j < len(text) and text[j] in " \t\n\r":
        j += 1
    if j >= len(text):
        raise ValueError("EOF at value")
    if text[j] not in "'`":
        return read_value(text, i)
    parts: list[str] = []
    cur = j
    while True:
        nxt, val = read_value(text, cur)
        if not isinstance(val, str):
            raise ValueError("expected only strings in concatenation")
        parts.append(val)
        cur = nxt
        while cur < len(text) and text[cur] in " \t\n\r":
            cur += 1
        if cur < len(text) and text[cur] == "+":
            cur += 1
            while cur < len(text) and text[cur] in " \t\n\r":
                cur += 1
            if cur >= len(text) or text[cur] not in "'`":
                raise ValueError("expected string after +")
            continue
        return cur, "".join(parts)


def parse_kb(text: str) -> dict[str, str | bool | int]:
    block = extract_kb_block(text)
    inner = block.strip()[1:-1]
    out: dict[str, str | bool | int] = {}
    i = 0
    while i < len(inner):
        m = re.match(r"\s*([A-Z_][A-Z0-9_]*)\s*:\s*", inner[i:])
        if not m:
            i += 1
            continue
        key = m.group(1)
        i += m.end()
        ni, val = read_kb_field_value(inner, i)
        out[key] = val
        i = ni
        while i < len(inner) and inner[i] in " \t\n\r,":
            i += 1
    return out


def main() -> None:
    text = CONFIG.read_text(encoding="utf-8")
    kb = parse_kb(text)
    mgr = default_manager_tg_username(text)
    order = [
        "REGISTRATION_CLOSED",
        "DATES",
        "NEXT_SHIFT_TEXT",
        "DEFAULT_SHIFT",
        "AVAILABLE_SHIFTS",
        "START_MESSAGE",
        "PROGRAM_TEXT",
        "CONDITIONS_TEXT",
        "PRICE",
        "DEPOSIT",
        "PAYMENT_SBER",
        "PAYMENT_INSTRUCTION",
        "LOCATION",
        "WHAT_INCLUDED",
        "WHAT_TO_TAKE",
        "OBJECTION_PRICE",
        "OBJECTION_SOLO",
        "OBJECTION_NO_ALCOHOL",
        "OBJECTION_NO_COMPANY",
        "MEDIA_CHANNEL",
        "MANAGER_FOR_COMPLEX",
        "CONSENT_PD_TEXT",
        "AFTER_PAYMENT_INSTRUCTION",
    ]
    rows: list[dict[str, str]] = []
    for k in order:
        if k == "PAYMENT_INSTRUCTION":
            rows.append({"key": k, "value": ORLYATNIK_PAYMENT_INSTRUCTION})
            continue
        if k not in kb:
            continue
        v = kb[k]
        if k == "MANAGER_FOR_COMPLEX" and isinstance(v, str):
            v = v.replace("${env.MANAGER_TG_USERNAME}", mgr)
        rows.append({"key": k, "value": "true" if v is True else "false" if v is False else str(v)})
    for fname, prompt in FIELD_PROMPTS.items():
        rows.append({"key": f"FIELD_PROMPT_{fname}", "value": prompt})
    OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Wrote", OUT, "entries:", len(rows))


if __name__ == "__main__":
    main()

"""Utility to import weekly schedule data from a CSV export.

Usage:
    C:/Users/zetin/AppData/Local/Programs/Python/Python311/python.exe import_schedule_csv.py path/to/file.csv

Notes:
- Treats every row as an independent assignment.
- Employees are matched by (name, position, group) in insertion order. Duplicate
  rows for the same combination will create additional employee entries as
  needed.
- Any existing employee schedules not touched by the import are cleared.
"""

from __future__ import annotations

import sys
import re
from pathlib import Path
from collections import defaultdict
from typing import Dict, Tuple

import pandas as pd

from app import app, db, Employee, Schedule

DAY_MAPPING = {
    'sat dec 6': 'saturday',
    'sun dec 7': 'sunday',
    'mon dec 8': 'monday',
    'tue dec 9': 'tuesday',
    'wed dec 10': 'wednesday',
    'thu dec 11': 'thursday',
    'fri dec 12': 'friday',
}

SHIFT_SANITIZE_RE = re.compile(r"\s+")


def _clean_text(value: str | float | int | None) -> str:
    """Normalize whitespace, strip NBSP characters, and coalesce to plain ASCII."""
    if value is None:
        return ''
    text = str(value)
    if text.lower() == 'nan':
        return ''
    text = text.replace('\xa0', ' ')
    text = text.replace('\u2013', '-')  # en dash
    text = text.replace('\u2014', '-')  # em dash
    text = text.replace('\u2012', '-')  # figure dash
    text = SHIFT_SANITIZE_RE.sub(' ', text)
    return text.strip()


def _clean_shift(value: str) -> str:
    """Return a cleaned shift string, preserving OFF/blank indicators."""
    cleaned = _clean_text(value)
    if not cleaned:
        return ''
    lower = cleaned.lower()
    if lower in {'off', 'vacation', 'training'}:
        return cleaned.upper()  # Standardize capitalization
    return cleaned


def _normalize_identity(name: str) -> str:
    base = _clean_text(name)
    # Remove any parenthetical nicknames or annotations
    base = re.sub(r'\([^)]*\)', '', base)
    # Collapse whitespace and lowercase for comparison
    base = SHIFT_SANITIZE_RE.sub(' ', base)
    return base.strip().lower()


def load_schedule(path: Path) -> None:
    if not path.exists():
        raise FileNotFoundError(f"CSV file not found: {path}")

    df = pd.read_csv(path, dtype=str).fillna('')

    with app.app_context():
    usage_tracker: Dict[Tuple[str, str, str], Employee] = {}
        touched_ids = set()
        created = 0
        updated = 0
        skipped_rows = []
        current_group = 'HELPLINE LEADERSHIP'

        for idx, raw_row in df.iterrows():
            row = {str(col).lower(): _clean_text(value) for col, value in raw_row.items()}
            name = row.get('employee', '')
            position = row.get('position', '')
            group_value = row.get('group', '')

            if group_value:
                current_group = group_value
            group = current_group

            # Skip rows with no meaningful employee name or rows that look like notes
            if not name or name[0].isdigit():
                skipped_rows.append((idx, name, 'missing-or-note'))
                continue

            normalized_name = _normalize_identity(name)
            normalized_position = _clean_text(position).lower()
            normalized_group = _clean_text(group).lower()
            key = (normalized_name, normalized_position, normalized_group)

            employee = usage_tracker.get(key)
            if employee is None:
                candidates = (Employee.query
                              .filter_by(department=group)
                              .order_by(Employee.id)
                              .all())
                employee = None
                for candidate in candidates:
                    if _normalize_identity(candidate.name) == normalized_name:
                        if not normalized_position or (candidate.position or '').strip().lower() == normalized_position:
                            employee = candidate
                            break
                if employee is None:
                    employee = Employee()
                    employee.name = name
                    employee.position = position
                    employee.department = group
                    db.session.add(employee)
                    db.session.flush()
                    schedule = Schedule()
                    schedule.employee_id = employee.id
                    db.session.add(schedule)
                    created += 1
                else:
                    schedule = employee.schedule
                    if not schedule:
                        schedule = Schedule()
                        schedule.employee_id = employee.id
                        db.session.add(schedule)
                    updated += 1
                usage_tracker[key] = employee
            else:
                # Existing in this run, make sure schedule exists
                schedule = employee.schedule
                if not schedule:
                    schedule = Schedule()
                    schedule.employee_id = employee.id
                    db.session.add(schedule)

            touched_ids.add(employee.id)

            for col_name, day_key in DAY_MAPPING.items():
                shift_value = row.get(col_name, '')
                cleaned = _clean_shift(shift_value)
                if not cleaned:
                    continue
                existing_shift = getattr(schedule, day_key)
                if existing_shift:
                    if cleaned.lower() in existing_shift.lower():
                        continue
                    combined = f"{existing_shift} / {cleaned}"
                    setattr(schedule, day_key, combined)
                else:
                    setattr(schedule, day_key, cleaned)

        # Clear schedules for employees not present in this import
        if touched_ids:
            other_employees = Employee.query.filter(~Employee.id.in_(touched_ids)).all()
            for emp in other_employees:
                if emp.schedule:
                    for day_key in DAY_MAPPING.values():
                        setattr(emp.schedule, day_key, '')

        db.session.commit()

        print(f"Import complete: created {created} employees, updated {updated}.")
        if skipped_rows:
            print("Skipped rows:")
            for idx, name, reason in skipped_rows:
                print(f"  Row {idx + 2}: {name!r} ({reason})")


def main(argv: list[str]) -> None:
    if len(argv) != 2:
        print("Usage: python import_schedule_csv.py path/to/shiftline_schedule_dec6_12.csv")
        sys.exit(1)
    path = Path(argv[1]).expanduser().resolve()
    load_schedule(path)


if __name__ == '__main__':
    main(sys.argv)

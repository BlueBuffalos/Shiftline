from flask import Flask, render_template, request, jsonify
from flask_sqlalchemy import SQLAlchemy
import pandas as pd
import os
from datetime import datetime, time, timedelta
import traceback
import re
import smtplib
from email.mime.text import MIMEText
try:
    from apscheduler.schedulers.background import BackgroundScheduler
except Exception:
    BackgroundScheduler = None
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///schedule.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.secret_key = 'your-secret-key-here'

db = SQLAlchemy(app)
# --- Helpers: time parsing and break calculation ---
def _parse_time_component(s: str) -> int:
    """Parse a time token like '9a', '9:30p', '12a', '12:15p' to minutes from midnight."""
    if not s:
        return 0
    s = s.strip().lower()
    # Normalize variants (ensure trailing a/p if missing) - if absent, assume hours only
    mer = 'a'
    if s.endswith('a') or s.endswith('p'):
        mer = s[-1]
        core = s[:-1]
    else:
        core = s
    parts = core.split(':')
    try:
        hour = int(parts[0]) if parts[0] else 0
        minute = int(parts[1]) if len(parts) > 1 and parts[1] else 0
    except ValueError:
        return 0
    # 12 AM is 0h; 12 PM is 12h
    if mer == 'a':
        hour = 0 if hour == 12 else hour
    else:  # 'p'
        hour = 12 if hour == 12 else hour + 12
    return hour * 60 + minute

def _shift_minutes(shift: str) -> int:
    """Return duration in minutes for a shift string like '9a-5p' or '9:30a-6p'. Returns 0 if unparsable or OFF."""
    if not shift:
        return 0
    txt = str(shift).strip().lower()
    if not txt or txt in ['off', 'vacation', 'training']:
        return 0
    if '-' not in txt:
        return 0
    try:
        start, end = [t.strip() for t in txt.split('-', 1)]
        sm = _parse_time_component(start)
        em = _parse_time_component(end)
        # Handle overnight ranges (e.g., 9p-6a)
        if em <= sm:
            em += 24 * 60
        return max(0, em - sm)
    except Exception:
        return 0

def _break_minutes_for_shift(shift: str) -> int:
    mins = _shift_minutes(shift)
    hours = mins / 60.0
    return 45 if hours > 6 else 21 if mins > 0 else 0

def _shift_window(shift: str):
    """Return (start_min, end_min) minutes from midnight for a single-day shift. Handles overnight by adding 24h to end."""
    if not shift or '-' not in str(shift):
        return None
    txt = str(shift).strip().lower()
    if txt in ['off','vacation','training','']:
        return None
    try:
        s,e = [t.strip() for t in txt.split('-',1)]
        sm = _parse_time_component(s)
        em = _parse_time_component(e)
        if em <= sm:
            em += 24*60
        return (sm, em)
    except Exception:
        return None

def _week_start_saturday(today: datetime.date) -> datetime.date:
    # Python weekday: Mon=0..Sun=6; we want last Saturday (5)
    wd = today.weekday()  # Mon=0
    # Days since last Saturday: (wd - 5) mod 7
    delta = (wd - 5) % 7
    return today - timedelta(days=delta)

def _week_dates_saturday_to_friday(today: datetime.date):
    start = _week_start_saturday(today)
    return [start + timedelta(days=i) for i in range(7)]

def _build_coverage_988():
    """Build per-day, per-30min slot coverage counts for department '988/CRISIS'."""
    day_keys = ['saturday','sunday','monday','tuesday','wednesday','thursday','friday']
    slots_per_day = 48  # 24h * 2 per hour
    coverage = {d: [0]*slots_per_day for d in day_keys}
    staff = Employee.query.filter_by(department='988/CRISIS').all()
    for emp in staff:
        if not emp.schedule:
            continue
        for idx, day in enumerate(day_keys):
            sh = getattr(emp.schedule, day)
            win = _shift_window(sh)
            if not win:
                continue
            sm, em = win
            start_slot = max(0, min(slots_per_day-1, sm // 30))
            end_slot = max(0, min(slots_per_day, (em + 29) // 30))
            for s in range(start_slot, end_slot):
                if 0 <= s < slots_per_day:
                    coverage[day][s] += 1
    return coverage

def _format_slot_time(slot_idx: int) -> str:
    # 30-min slots: 0..47
    minutes = slot_idx * 30
    h = (minutes // 60) % 24
    m = minutes % 60
    mer = 'a' if h < 12 else 'p'
    h12 = 12 if h % 12 == 0 else h % 12
    return f"{h12}{':' + str(m).zfill(2) if m else ''}{mer}"

def _stddev(values):
    vals = [v for v in values if isinstance(v, (int, float))]
    n = len(vals)
    if n < 2:
        return 0.0
    mean = sum(vals)/n
    var = sum((v-mean)**2 for v in vals)/(n-1)
    return var ** 0.5

def _is_free(schedule: 'Schedule', day_key: str, sm: int, em: int) -> bool:
    """Return True if no overlap between [sm,em) and the employee's shift on day_key."""
    if not schedule:
        return True
    win = _shift_window(getattr(schedule, day_key))
    if not win:
        return True
    s2, e2 = win
    # Check overlap in simple minutes domain; treat both in same day frame
    return not (sm < e2 and em > s2)

def _slot_range_to_strings(start_idx: int, end_idx: int):
    return _format_slot_time(start_idx), _format_slot_time(end_idx)

def _day_key_to_title(dk: str) -> str:
    return dk.capitalize()

def _ensure_schedule_column_meta():
    defaults = [
        ('saturday', 'Saturday'),
        ('sunday', 'Sunday'),
        ('monday', 'Monday'),
        ('tuesday', 'Tuesday'),
        ('wednesday', 'Wednesday'),
        ('thursday', 'Thursday'),
        ('friday', 'Friday'),
    ]
    created = False
    for order, (day_key, label) in enumerate(defaults):
        meta = ScheduleColumnMeta.query.get(day_key)
        if not meta:
            meta = ScheduleColumnMeta()
            meta.day_key = day_key
            meta.display_name = label
            meta.subtitle = ''
            meta.is_visible = True
            meta.sort_order = order
            db.session.add(meta)
            created = True
    if created:
        db.session.commit()

def _generate_coverage_suggestions():
    cov = _build_coverage_988()
    day_keys = ['saturday','sunday','monday','tuesday','wednesday','thursday','friday']
    staff = Employee.query.filter_by(department='988/CRISIS').all()
    slots = 48
    created = []
    for day in day_keys:
        arr = cov[day]
        i = 0
        while i < slots:
            lvl = arr[i]
            target = 0
            severity = None
            if lvl < 2:
                target = 2
                severity = 'critical'
            elif lvl < 3:
                target = 3
                severity = 'warn'
            else:
                i += 1
                continue
            start = i
            while i < slots and arr[i] < target:
                i += 1
            end = i
            sm = start * 30
            em = end * 30
            candidate = None
            for emp in staff:
                if _is_free(emp.schedule, day, sm, em):
                    candidate = emp
                    break
            st_str, et_str = _slot_range_to_strings(start, end)
            title = f"Backfill {severity.upper()} gap: {_day_key_to_title(day)} {st_str}-{et_str}"
            desc = f"Assign coverage to reach ≥{target} on 988/CRISIS between {st_str}-{et_str} on {_day_key_to_title(day)}."
            sug = Suggestion(
                type='coverage_backfill',
                title=title,
                description=desc,
                day_key=day,
                start_time=st_str,
                end_time=et_str,
                employee_id=candidate.id if candidate else None,
                status='pending'
            )
            db.session.add(sug)
            created.append(sug)
    db.session.commit()
    return created

def _compute_coverage_suggestions_preview():
    """Return a list of coverage backfill suggestions without persisting to DB.
    Each item: { day_key, from, to, needed, current, suggested_backfill: [{id,name}], severity }
    """
    cov = _build_coverage_988()
    day_keys = ['saturday','sunday','monday','tuesday','wednesday','thursday','friday']
    slots = 48
    staff = Employee.query.filter_by(department='988/CRISIS').all()
    suggestions = []
    for day in day_keys:
        arr = cov[day]
        i = 0
        while i < slots:
            level = arr[i]
            if level >= 3:
                i += 1
                continue
            start = i
            target = 2 if level < 2 else 3
            while i < slots and arr[i] < target:
                i += 1
            end = i
            sm = start * 30
            em = end * 30
            free = []
            for emp in staff:
                if _is_free(emp.schedule, day, sm, em):
                    free.append({'id': emp.id, 'name': emp.name})
                if len(free) >= 5:
                    break
            suggestions.append({
                'day_key': day,
                'from': _format_slot_time(start),
                'to': _format_slot_time(end),
                'needed': target,
                'current': level,
                'severity': 'critical' if target == 2 else 'warn',
                'suggested_backfill': free
            })
    return suggestions

def _compute_predictive_insights():
    """Compute employee burnout insights plus a preview of coverage backfills.
    Returns an object with keys: employees (list), coverage_suggestions (list)
    """
    employees_out = []
    employees = Employee.query.all()
    today = datetime.now().date()
    week_days = ['saturday','sunday','monday','tuesday','wednesday','thursday','friday']
    week_dates = _week_dates_saturday_to_friday(today)
    cov988 = _build_coverage_988()
    slots_per_day = 48
    REST_THRESHOLD_MIN = 10*60

    for emp in employees:
        history = TimeOffRequest.query.filter_by(employee_id=emp.id).all()
        sick_count = sum(1 for r in history if r.request_type == 'sick')
        pto_count = sum(1 for r in history if r.request_type == 'pto')
        vacation_count = sum(1 for r in history if r.request_type == 'vacation')
        sched = emp.schedule
        if not sched:
            continue
        weekly_minutes = 0
        day_windows = []
        for day_key in week_days:
            sh = getattr(sched, day_key)
            weekly_minutes += _shift_minutes(sh)
            win = _shift_window(sh)
            day_windows.append((day_key, win))
        start_minutes = []
        night_shifts = 0
        weekend_minutes = 0
        heavy_threshold = 9*60
        max_heavy_streak = 0
        current_streak = 0
        night_sequences = 0
        in_night_streak = False
        for idx, (day_key, win) in enumerate(day_windows):
            if win:
                sm, em = win
                start_minutes.append(sm % (24*60))
                is_night = ((sm % (24*60)) >= 20*60) or ((em % (24*60)) <= 6*60)
                if is_night:
                    night_shifts += 1
                    if not in_night_streak:
                        in_night_streak = True
                        night_sequences += 1
                else:
                    in_night_streak = False
                if day_key in ['saturday','sunday']:
                    weekend_minutes += (em - sm)
                if (em - sm) >= heavy_threshold:
                    current_streak += 1
                    max_heavy_streak = max(max_heavy_streak, current_streak)
                else:
                    current_streak = 0
        start_variability_hours = round(_stddev(start_minutes)/60.0, 2)
        workdays = [getattr(sched, d) for d in ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']]
        workday_count = sum(1 for d in workdays if d and d.lower() not in ['off', 'vacation', ''])
        weekly_hours = weekly_minutes/60.0
        # Rest violations
        rest_violations = 0
        for i in range(len(day_windows)-1):
            _, w1 = day_windows[i]
            _, w2 = day_windows[i+1]
            if not w1 or not w2:
                continue
            gap = (24*60 - w1[1] % (24*60)) + (w2[0] % (24*60))
            if gap < REST_THRESHOLD_MIN:
                rest_violations += 1
        approved = [r for r in history if r.status == 'approved']
        overlap_dates = []
        for r in approved:
            try:
                rs = datetime.strptime(r.start_date, '%Y-%m-%d').date()
                re = datetime.strptime(r.end_date, '%Y-%m-%d').date()
            except Exception:
                continue
            for d in week_dates:
                if rs <= d <= re:
                    overlap_dates.append(d.isoformat())
        overlap_dates = sorted(list(set(overlap_dates)))
        cov_crit = 0
        cov_warn = 0
        if emp.department == '988/CRISIS':
            for idx, (day_key, win) in enumerate(day_windows):
                if not win:
                    continue
                sm, em = win
                start_slot = max(0, min(slots_per_day-1, sm // 30))
                end_slot = max(0, min(slots_per_day, (em + 29) // 30))
                for s in range(start_slot, end_slot):
                    c = cov988[day_key][s]
                    if c < 2:
                        cov_crit += 1
                    elif c < 3:
                        cov_warn += 1

        # Risk scoring (0-100)
        def clamp(v, lo, hi):
            return max(lo, min(hi, v))
        score = 0.0
        # Weekly hours: 40->60 maps to 0->30
        wh_points = clamp((weekly_hours - 40.0) / 20.0, 0.0, 1.0) * 30.0
        score += wh_points
        # Rest violations: 0..3 -> 0..25
        rv_points = clamp(rest_violations / 3.0, 0.0, 1.0) * 25.0
        score += rv_points
        # Heavy streak: 0..4 -> 0..20
        hs_points = clamp(max_heavy_streak / 4.0, 0.0, 1.0) * 20.0
        score += hs_points
        # Night sequences: 0..3 -> 0..15
        ns_points = clamp(night_sequences / 3.0, 0.0, 1.0) * 15.0
        score += ns_points
        # Start time variability: 0..6h -> 0..10
        sv_points = clamp(start_variability_hours / 6.0, 0.0, 1.0) * 10.0
        score += sv_points
        # Weekend hours: 0..12 -> 0..10
        we_points = clamp((weekend_minutes/60.0) / 12.0, 0.0, 1.0) * 10.0
        score += we_points
        risk_score = round(clamp(score, 0.0, 100.0), 0)
        risk_level = 'low' if risk_score < 35 else 'medium' if risk_score < 60 else 'high'

        drivers = []
        if wh_points >= 5: drivers.append(f"High weekly hours: {round(weekly_hours,1)}h")
        if rv_points >= 5: drivers.append(f"Rest gaps <10h: {rest_violations}x")
        if hs_points >= 5: drivers.append(f"Heavy shift streak: {max_heavy_streak}")
        if ns_points >= 5: drivers.append(f"Night sequences: {night_sequences}")
        if sv_points >= 5: drivers.append(f"Start-time variability: {start_variability_hours}h")
        if we_points >= 5: drivers.append(f"Weekend load: {round(weekend_minutes/60.0,1)}h")

        # Simple narrative
        if risk_level == 'high':
            narrative = 'High burnout risk driven by ' + ', '.join(drivers[:3])
        elif risk_level == 'medium':
            narrative = 'Moderate risk; monitor and adjust for ' + ', '.join(drivers[:2] or ['balanced load'])
        else:
            narrative = 'Low risk; workload appears balanced'

        employees_out.append({
            'employee_id': emp.id,
            'employee_name': emp.name,
            'department': emp.department,
            'sick_days': sick_count,
            'pto_days': pto_count,
            'vacation_days': vacation_count,
            'workdays_this_week': workday_count,
            'weekly_minutes': weekly_minutes,
            'weekly_hours': round(weekly_hours, 1),
            'night_shifts': night_shifts,
            'night_sequences': night_sequences,
            'start_time_variability_hours': start_variability_hours,
            'weekend_hours': round(weekend_minutes/60.0, 1),
            'max_heavy_streak': max_heavy_streak,
            'rest_violations': rest_violations,
            'pto_overlap_dates': overlap_dates,
            'coverage_critical_slots': cov_crit,
            'coverage_warn_slots': cov_warn,
            'burnout_risk': risk_level != 'low',
            'risk_level': risk_level,
            'risk_score': int(risk_score),
            'drivers': drivers,
            'narrative': narrative
        })
    return {
        'employees': employees_out,
        'coverage_suggestions': _compute_coverage_suggestions_preview()
    }

@app.route('/api/email/insights', methods=['POST'])
def email_insights_now():
    recipients_param = request.json.get('recipients') if request.is_json else None
    to_list = recipients_param or os.getenv('ADMIN_REPORT_EMAILS', 'Freeranger77@gmail.com')
    recipients = [e.strip() for e in to_list.split(',') if e.strip()]
    pending = Suggestion.query.filter_by(status='pending').all()
    approved = Suggestion.query.filter_by(status='approved').order_by(Suggestion.created_at.desc()).limit(20).all()
    lines = ['Daily ShiftLine Insights (manual send)', '']
    lines.append(f'Pending suggestions: {len(pending)}')
    for s in pending[:25]:
        who = f" -> {s.employee.name}" if s.employee else ''
        when = f" on {_day_key_to_title(s.day_key)} {s.start_time}-{s.end_time}" if s.day_key and s.start_time else ''
        lines.append(f"- [{s.type}] {s.title}{when}{who}")
    if approved:
        lines.append('\nRecent approvals:')
        for s in approved:
            lines.append(f"- {s.title}")
    body = '\n'.join(lines)
    for to in recipients:
        send_email(to, 'ShiftLine Insights', body)
    return jsonify({'sent_to': recipients, 'count': len(recipients)})

def _generate_burnout_suggestions():
    created = []
    for emp in _compute_predictive_insights():
        if emp.get('burnout_risk'):
            title = f"Mitigate burnout risk for {emp['employee_name']}"
            desc = (
                f"Recommendation: {emp['recommendation']}. Drivers — weekly_hours: {emp['weekly_hours']}, "
                f"rest_violations: {emp['rest_violations']}, night_shifts: {emp['night_shifts']}, "
                f"start_variability: {emp['start_time_variability_hours']}h, heavy_streak: {emp['max_heavy_streak']}."
            )
            sug = Suggestion(
                type='burnout_mitigation', title=title, description=desc, status='pending', employee_id=emp['employee_id']
            )
            db.session.add(sug)
            created.append(sug)
    db.session.commit()
    return created

def _ensure_daily_scheduler(app):
    if BackgroundScheduler is None:
        app.logger.warning('APScheduler not installed; daily emails disabled.')
        return None
    scheduler = BackgroundScheduler(daemon=True)
    def job():
        with app.app_context():
            _generate_coverage_suggestions()
            _generate_burnout_suggestions()
            to_list = os.getenv('ADMIN_REPORT_EMAILS', 'Freeranger77@gmail.com')
            recipients = [e.strip() for e in to_list.split(',') if e.strip()]
            pending = Suggestion.query.filter_by(status='pending').all()
            approved = Suggestion.query.filter_by(status='approved').order_by(Suggestion.created_at.desc()).limit(20).all()
            lines = ['Daily ShiftLine Insights', '', f'Pending suggestions: {len(pending)}']
            for s in pending[:25]:
                who = f" -> {s.employee.name}" if s.employee else ''
                when = f" on {_day_key_to_title(s.day_key)} {s.start_time}-{s.end_time}" if s.day_key and s.start_time else ''
                lines.append(f"- [{s.type}] {s.title}{when}{who}")
            if approved:
                lines.append('\nRecent approvals:')
                for s in approved:
                    lines.append(f"- {s.title}")
            body = '\n'.join(lines)
            for to in recipients:
                send_email(to, 'Daily ShiftLine Insights', body)
    scheduler.add_job(job, 'cron', hour=5, minute=30, id='daily_insights_email', replace_existing=True)
    scheduler.start()
    return scheduler

@app.route('/api/coverage/988/detailed', methods=['GET'])
def api_coverage_988_detailed():
    """Return under-covered intervals and suggested backfills for 988/CRISIS.
    critical: <2, warn: <3. Suggestions: employees in 988 free in that interval.
    """
    cov = _build_coverage_988()
    day_keys = ['saturday','sunday','monday','tuesday','wednesday','thursday','friday']
    slots = 48
    # Build runs of under-coverage per day
    result = {}
    staff = Employee.query.filter_by(department='988/CRISIS').all()
    for day in day_keys:
        arr = cov[day]
        issues = []
        i = 0
        while i < slots:
            level = arr[i]
            if level >= 3:
                i += 1
                continue
            # Start a run
            start = i
            target = 2 if level < 2 else 3
            while i < slots and arr[i] < target:
                i += 1
            end = i  # non-inclusive
            # Build interval label
            start_label = _format_slot_time(start)
            end_label = _format_slot_time(end)
            sev = 'critical' if target == 2 else 'warn'
            # Suggest up to 3 free employees
            sm = start * 30
            em = end * 30
            free = []
            for emp in staff:
                if _is_free(emp.schedule, day, sm, em):
                    free.append({'id': emp.id, 'name': emp.name})
                if len(free) >= 3:
                    break
            issues.append({'severity': sev, 'from': start_label, 'to': end_label, 'needed': (2 if sev=='critical' else 3), 'coverage': level, 'suggested_backfill': free})
        result[day] = issues
    return jsonify(result)

@app.route('/api/break-allowance', methods=['GET'])
def api_break_allowance():
    """Compute break minutes allowed for an employee per day this week, optional filter by day.
    Query: employee_id (required), day (optional: saturday..friday)
    """
    emp_id = request.args.get('employee_id', type=int)
    day = request.args.get('day')
    if not emp_id:
        return jsonify({'error': 'employee_id is required'}), 400
    emp = Employee.query.get(emp_id)
    if not emp or not emp.schedule:
        return jsonify({'employee_id': emp_id, 'days': {}, 'total_break_minutes': 0})
    valid_days = ['saturday','sunday','monday','tuesday','wednesday','thursday','friday']
    if day and day.lower() not in valid_days:
        return jsonify({'error': f'day must be one of {", ".join(valid_days)}'}), 400
    days = {}
    for d in valid_days:
        shift = getattr(emp.schedule, d)
        days[d] = {
            'shift': shift or '',
            'minutes': _break_minutes_for_shift(shift)
        }
    if day:
        d = day.lower()
        return jsonify({'employee_id': emp_id, 'day': d, 'minutes': days[d]['minutes'], 'shift': days[d]['shift']})
    total = sum(v['minutes'] for v in days.values())
    return jsonify({'employee_id': emp_id, 'days': days, 'total_break_minutes': total})

@app.route('/api/coverage/988', methods=['GET'])
def api_coverage_988():
    """Simple coverage counts for department '988/CRISIS' per day (ignores time overlaps)."""
    staff = Employee.query.filter_by(department='988/CRISIS').all()
    counts = {d: 0 for d in ['saturday','sunday','monday','tuesday','wednesday','thursday','friday']}
    for emp in staff:
        if not emp.schedule:
            continue
        for d in counts.keys():
            val = getattr(emp.schedule, d)
            if val and str(val).strip().lower() not in ['off', 'vacation', '']:
                counts[d] += 1
    # Flags: warn if <2, ok if >=2, prefer if >=3
    status = {k: ('critical' if v < 2 else 'ok' if v >= 2 else 'warn') for k, v in counts.items()}
    prefer = {k: (v >= 3) for k, v in counts.items()}
    return jsonify({'department': '988/CRISIS', 'counts': counts, 'status': status, 'prefer3': prefer})

# Placeholder email sender (console log only)
def send_email(to_address: str, subject: str, body: str):
    host = os.getenv('SMTP_HOST')
    port = int(os.getenv('SMTP_PORT', '0') or '0')
    user = os.getenv('SMTP_USER')
    password = os.getenv('SMTP_PASSWORD')
    use_tls = os.getenv('SMTP_USE_TLS', '1').lower() in ['1','true','yes']
    from_addr = os.getenv('FROM_EMAIL', user or 'no-reply@shiftline.local')
    if host and port and user and password:
        try:
            msg = MIMEText(body)
            msg['Subject'] = subject
            msg['From'] = from_addr
            msg['To'] = to_address
            with smtplib.SMTP(host, port, timeout=10) as server:
                if use_tls:
                    server.starttls()
                server.login(user, password)
                server.sendmail(from_addr, [to_address], msg.as_string())
            return
        except Exception as ex:
            print(f"[Email fallback] SMTP failed: {ex}")
    print("=== EMAIL NOTIFICATION ===")
    print(f"To: {to_address}")
    print(f"Subject: {subject}")
    print(body)
    print("==========================")

class Employee(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    position = db.Column(db.String(100))
    supervisor = db.Column(db.String(100))
    department = db.Column(db.String(100))
    schedule = db.relationship('Schedule', backref='employee', uselist=False)
    tasks = db.relationship('Task', backref='employee', lazy=True)
    # Time off relationship for requests
    time_off_requests = db.relationship('TimeOffRequest', backref='employee', lazy=True)

    def to_dict(self):
        schedule_data = self.schedule.to_dict() if self.schedule else {}
        return {
            'id': self.id,
            'employee_name': self.name,
            'position': self.position,
            'supervisor': self.supervisor,
            'department': self.department,
            **schedule_data
        }

class Schedule(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    employee_id = db.Column(db.Integer, db.ForeignKey('employee.id'), nullable=False)
    saturday = db.Column(db.String(20))
    sunday = db.Column(db.String(20))
    monday = db.Column(db.String(20))
    tuesday = db.Column(db.String(20))
    wednesday = db.Column(db.String(20))
    thursday = db.Column(db.String(20))
    friday = db.Column(db.String(20))

    def to_dict(self):
        return {
            'saturday': self.saturday,
            'sunday': self.sunday,
            'monday': self.monday,
            'tuesday': self.tuesday,
            'wednesday': self.wednesday,
            'thursday': self.thursday,
            'friday': self.friday
        }
        
    def is_available(self, day_of_week, start_time, end_time):
        """Check if employee is available on specified day and time"""
        day_schedule = getattr(self, day_of_week.lower())
        if not day_schedule:
            # No schedule for this day, they're free
            return True
            
        if '-' not in day_schedule:
            # Irregularly formatted schedule
            return False
            
        # Parse schedule times
        try:
            sched_start, sched_end = day_schedule.split('-')
            # Convert to 24-hour format for easier comparison
            sched_start_hour = int(sched_start.replace('a', '').replace('p', '').replace(':', ''))
            sched_end_hour = int(sched_end.replace('a', '').replace('p', '').replace(':', ''))
            
            # Adjust for PM
            if 'p' in sched_start.lower() and sched_start_hour < 12:
                sched_start_hour += 12
            if 'p' in sched_end.lower() and sched_end_hour < 12:
                sched_end_hour += 12
                
            # Adjust for AM
            if 'a' in sched_start.lower() and sched_start_hour == 12:
                sched_start_hour = 0
            if 'a' in sched_end.lower() and sched_end_hour == 12:
                sched_end_hour = 0
                
            # Do the same for requested times
            req_start_hour = int(start_time.replace('a', '').replace('p', '').replace(':', ''))
            req_end_hour = int(end_time.replace('a', '').replace('p', '').replace(':', ''))
            
            if 'p' in start_time.lower() and req_start_hour < 12:
                req_start_hour += 12
            if 'p' in end_time.lower() and req_end_hour < 12:
                req_end_hour += 12
                
            if 'a' in start_time.lower() and req_start_hour == 12:
                req_start_hour = 0
            if 'a' in end_time.lower() and req_end_hour == 12:
                req_end_hour = 0
                
            # Check for overlap (not available if there's overlap)
            return not (req_start_hour < sched_end_hour and req_end_hour > sched_start_hour)
            
        except Exception:
            # If we can't parse the schedule format, assume not available
            return False

class ScheduleColumnMeta(db.Model):
    day_key = db.Column(db.String(20), primary_key=True)
    display_name = db.Column(db.String(40), nullable=False)
    subtitle = db.Column(db.String(40))
    is_visible = db.Column(db.Boolean, default=True)
    sort_order = db.Column(db.Integer, default=0)

    def to_dict(self):
        return {
            'day_key': self.day_key,
            'display_name': self.display_name,
            'subtitle': self.subtitle or '',
            'is_visible': bool(self.is_visible),
            'sort_order': self.sort_order
        }

class Task(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    employee_id = db.Column(db.Integer, db.ForeignKey('employee.id'), nullable=False)
    task_name = db.Column(db.String(100), nullable=False)
    day_of_week = db.Column(db.String(10), nullable=False)
    start_time = db.Column(db.String(10), nullable=False)
    end_time = db.Column(db.String(10), nullable=False)
    required_skill = db.Column(db.String(100))
    
    def to_dict(self):
        return {
            'id': self.id,
            'employee_id': None,  # Avoid relationship error
            'task_name': self.task_name,
            'day_of_week': self.day_of_week,
            'start_time': self.start_time,
            'end_time': self.end_time,
            'required_skill': self.required_skill
        }

class Announcement(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(100), nullable=False)
    content = db.Column(db.Text, nullable=False)
    type = db.Column(db.String(20), default='normal')  # normal, important, urgent
    date = db.Column(db.Date, default=datetime.now().date)
    
    def to_dict(self):
        return {
            'id': self.id,
            'title': self.title,
            'content': self.content,
            'type': self.type,
            'date': self.date.isoformat() if self.date else None
        }

class TimeOffRequest(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    employee_id = db.Column(db.Integer, db.ForeignKey('employee.id'), nullable=False)
    request_type = db.Column(db.String(20), nullable=False)  # sick, vacation, pto
    start_date = db.Column(db.String(20), nullable=False)
    end_date = db.Column(db.String(20), nullable=False)
    reason = db.Column(db.Text)
    status = db.Column(db.String(20), default='pending')  # pending, approved, denied

    def to_dict(self):
        return {
            'id': self.id,
            'employee_id': self.employee_id,
            'employee_name': self.employee.name if self.employee else '',
            'request_type': self.request_type,
            'start_date': self.start_date,
            'end_date': self.end_date,
            'reason': self.reason,
            'status': self.status
        }

class Suggestion(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    type = db.Column(db.String(64), nullable=False)  # coverage_backfill, burnout_mitigation
    title = db.Column(db.String(255), nullable=False)
    description = db.Column(db.Text, default='')
    day_key = db.Column(db.String(16))  # saturday..friday
    start_time = db.Column(db.String(16))
    end_time = db.Column(db.String(16))
    employee_id = db.Column(db.Integer, db.ForeignKey('employee.id'))
    status = db.Column(db.String(16), default='pending')  # pending, approved, denied
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    employee = db.relationship('Employee')

    def to_dict(self):
        return {
            'id': self.id,
            'type': self.type,
            'title': self.title,
            'description': self.description,
            'day_key': self.day_key,
            'start_time': self.start_time,
            'end_time': self.end_time,
            'employee_id': self.employee_id,
            'employee_name': self.employee.name if self.employee else None,
            'status': self.status,
            'created_at': self.created_at.isoformat()
        }

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/upload-schedule', methods=['POST'])
def upload_schedule():
    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400

    file = request.files['file']
    if not file or not getattr(file, 'filename', '').endswith('.csv'):
        return jsonify({'error': 'Invalid file format. Please upload a CSV file'}), 400

    try:
        # Read CSV file
        df = pd.read_csv(file.stream)
        print(f"CSV columns: {df.columns.tolist()}")  # Debug log
        current_department = None

        # List of valid department names (update as needed)
        valid_departments = [
            "HELPLINE LEADERSHIP",
            "TEAM LEADERS/COORDINATORS/SPECIALISTS",
            "211 HELPLINE",
            "988/CRISIS",
            "CARE COORDINATORS/PEER SPECIALISTS",
            "CHAT/EMAIL/TEXT",
            "COURT/COMMUNITY RELATIONS",
            "ELC ANSWERING SERVICE",
            "TOUCHLINE",
            "AVAILABLE SHIFTS"
        ]
        valid_departments_lower = [d.lower() for d in valid_departments]

        # Clear existing data
        # Task.query.delete()  # Commented out to preserve existing data

        # Optionally, merge new data with existing data
        # Implement logic here to avoid overwriting existing tasks

        # Detect the correct name column
        name_col = 'Name'
        if 'Employee' in df.columns:
            name_col = 'Employee'
        elif 'Name' in df.columns:
            name_col = 'Name'
        else:
            raise Exception('No valid name column found (expected "Employee" or "Name")')

        # Track if we've reached the end of real schedule sections
        stop_import = False
        found_first_dept_header = False
        current_department = 'HELPLINE LEADERSHIP'

        for _, row in df.iterrows():
            if stop_import:
                break
            # Skip blank rows
            if all((pd.isna(x) or str(x).strip() == '') for x in row):
                continue
            name_val = str(row[name_col]).strip() if pd.notna(row[name_col]) else ''
            def is_effectively_empty(val):
                return pd.isna(val) or str(val).replace('\xa0', '').strip() == ''
            # Detect department header
            if name_val and name_val.lower().strip() in valid_departments_lower and all(is_effectively_empty(row[c]) for c in df.columns if c != name_col):
                current_department = name_val.strip()
                found_first_dept_header = True
                print(f"Found department: {current_department}")
                if name_val.upper().strip() == 'AVAILABLE SHIFTS':
                    stop_import = True
                continue
            # Skip rows with no employee name
            if not name_val:
                continue
            # All other rows are employees
            full_name = name_val
            position_col = 'Position' if 'Position' in df.columns else 'Position '
            supervisor_col = 'Supervisor' if 'Supervisor' in df.columns else None
            department_col = 'Department' if 'Department' in df.columns else None
            position = row.get(position_col, None)
            supervisor = row.get(supervisor_col, None) if supervisor_col else None
            clean_name = re.sub(r'[,(].*', '', full_name).strip()
            position_str = str(position).strip() if pd.notna(position) else None
            # Assign department: before first header, always HELPLINE LEADERSHIP
            if not found_first_dept_header:
                employee_department = 'HELPLINE LEADERSHIP'
            elif department_col and pd.notna(row.get(department_col, None)) and str(row[department_col]).strip():
                employee_department = str(row[department_col]).strip()
            else:
                employee_department = current_department
            employee = Employee()
            employee.name = clean_name
            employee.position = position_str
            employee.supervisor = str(supervisor).strip() if supervisor else None
            employee.department = employee_department
            db.session.add(employee)
            db.session.flush()
            print(f"Added employee: {employee.name}, position: {employee.position}, dept: {employee.department}")
            schedule = Schedule()
            schedule.employee_id = employee.id
            schedule.saturday = str(row['Saturday']).strip() if pd.notna(row.get('Saturday', None)) else None
            schedule.sunday = str(row['Sunday']).strip() if pd.notna(row.get('Sunday', None)) else None
            schedule.monday = str(row['Monday']).strip() if pd.notna(row.get('Monday', None)) else None
            schedule.tuesday = str(row['Tuesday']).strip() if pd.notna(row.get('Tuesday', None)) else None
            schedule.wednesday = str(row['Wednesday']).strip() if pd.notna(row.get('Wednesday', None)) else None
            schedule.thursday = str(row['Thursday']).strip() if pd.notna(row.get('Thursday', None)) else None
            schedule.friday = str(row['Friday']).strip() if pd.notna(row.get('Friday', None)) else None
            db.session.add(schedule)
        db.session.commit()
        
        # Debug: Print first 10 employees and their departments
        employees = Employee.query.all()
        print('First 10 employees after import:')
        for emp in employees[:10]:
            print(f"{emp.name} | {emp.position} | {emp.department}")

        # Debug - Count employees and positions
        employees = Employee.query.all()
        positions = set(e.position for e in employees if e.position)
        departments = set(e.department for e in employees if e.department)
        
        print(f"Total employees added: {len(employees)}")
        print(f"Positions found: {positions}")
        print(f"Departments found: {departments}")
        
        return jsonify({'message': 'Schedule imported successfully'})

    except Exception as e:
        db.session.rollback()
        print(f"Error processing file: {str(e)}")
        print(traceback.format_exc())  # Print full exception traceback
        return jsonify({'error': f'Error processing file: {str(e)}'}), 500

@app.route('/api/positions', methods=['GET'])
def get_positions():
    employees = Employee.query.all()
    positions = []
    
    # Names to exclude - these should not appear in positions list
    excluded_names = [
        'Alex', 'Ashley', 'Brenda Martinez', 'Brianna', 'Drizzban', 
        'Jasmine', 'Jocy', 'Kimberley', 'Kristen', 'Lisandro', 
        'Miranda', 'Naomi', 'Ronda', 'rachael', 'Sara', 'Taila'
    ]
    
    # Also create patterns to match variations of these names
    excluded_patterns = [name.lower() for name in excluded_names]
    
    for emp in employees:
        if emp.position and emp.position.strip() and emp.position.strip() != 'nan':
            position = emp.position.strip()
            
            # Skip if position matches an excluded name
            if any(position.lower() == pattern for pattern in excluded_patterns):
                continue
                
            # Skip if position contains common name patterns
            if position.count(' ') <= 1 and len(position) <= 20:
                # This is likely a name (first name or first+last) rather than a position
                # Most legitimate positions would have more words or be longer
                if position.split()[0].lower() in [name.lower().split()[0] for name in excluded_names]:
                    continue
            
            positions.append(position)
    
    # Debug log
    print(f"Positions returned (after filtering out names): {positions}")
    
    # Remove duplicates and sort
    positions = sorted(list(set(positions)))
    return jsonify(positions)

@app.route('/api/departments', methods=['GET'])
def get_departments():
    employees = Employee.query.all()
    departments = []
    for emp in employees:
        if emp.department and emp.department.strip() and emp.department.strip() != 'nan':
            departments.append(emp.department.strip())
    
    # Debug log
    print(f"Departments returned: {departments}")
    
    # Remove duplicates and sort
    departments = sorted(list(set(departments)))
    return jsonify(departments)

@app.route('/api/employees', methods=['GET', 'POST'])
def employees_collection():
    if request.method == 'POST':
        data = request.json or {}
        name = (data.get('name') or '').strip()
        position = (data.get('position') or '').strip()
        department = (data.get('department') or '').strip()
        supervisor = (data.get('supervisor') or '').strip() or None
        if not name:
            return jsonify({'error': 'Name is required'}), 400
        employee = Employee()
        employee.name = name
        employee.position = position
        employee.department = department
        employee.supervisor = supervisor
        db.session.add(employee)
        db.session.flush()

        schedule = Schedule.query.filter_by(employee_id=employee.id).first()
        if not schedule:
            schedule = Schedule()
            schedule.employee_id = employee.id
            db.session.add(schedule)
        schedule_data = data.get('schedule') or {}
        valid_days = ['saturday','sunday','monday','tuesday','wednesday','thursday','friday']
        for day in valid_days:
            value = schedule_data.get(day)
            setattr(schedule, day, value or '')
        db.session.commit()
        return jsonify({'message': 'Employee created', 'employee': employee.to_dict()}), 201

    employees = Employee.query.all()
    return jsonify([emp.to_dict() for emp in employees])

@app.route('/api/employees/by-position/<position>', methods=['GET'])
def get_employees_by_position(position):
    employees = Employee.query.filter_by(position=position).all()
    return jsonify([emp.to_dict() for emp in employees])

@app.route('/api/employees/by-department/<department>', methods=['GET'])
def get_employees_by_department(department):
    employees = Employee.query.filter_by(department=department).all()
    return jsonify([emp.to_dict() for emp in employees])

@app.route('/api/employees/<int:employee_id>', methods=['DELETE', 'PATCH'])
def employee_detail(employee_id):
    employee = Employee.query.get_or_404(employee_id)
    if request.method == 'DELETE':
        # Remove schedule first to maintain integrity
        if employee.schedule:
            db.session.delete(employee.schedule)
        db.session.delete(employee)
        db.session.commit()
        return jsonify({'message': 'Employee deleted'})

    data = request.json or {}
    if 'name' in data:
        employee.name = (data['name'] or '').strip()
    if 'position' in data:
        employee.position = (data['position'] or '').strip()
    if 'department' in data:
        employee.department = (data['department'] or '').strip()
    if 'supervisor' in data:
        employee.supervisor = (data['supervisor'] or '').strip() or None

    schedule_data = data.get('schedule')
    if schedule_data is not None:
        schedule = employee.schedule
        if not schedule:
            schedule = Schedule()
            schedule.employee_id = employee.id
            db.session.add(schedule)
        valid_days = ['saturday','sunday','monday','tuesday','wednesday','thursday','friday']
        for day in valid_days:
            if day in schedule_data:
                setattr(schedule, day, schedule_data.get(day) or '')

    db.session.commit()
    return jsonify({'message': 'Employee updated', 'employee': employee.to_dict()})

@app.route('/api/employees/available', methods=['GET'])
def get_available_employees():
    day = request.args.get('day')
    start_time = request.args.get('start_time')
    end_time = request.args.get('end_time')
    position = request.args.get('position')
    include_all = str(request.args.get('include_all', '0')).lower() in ['1','true','yes']
    
    # Basic validation
    if not all([day, start_time, end_time]):
        return jsonify({'error': 'Missing required parameters'}), 400
        
    # Find employees with matching position and availability
    results = []
    
    query = Employee.query
    if position:
        query = query.filter_by(position=position)
    
    employees = query.all()
    
    # Parse requested window
    try:
        r_sm = _parse_time_component(str(start_time))
        r_em = _parse_time_component(str(end_time))
        if r_em <= r_sm:
            r_em += 24*60
    except Exception:
        return jsonify({'error': 'Invalid time format for start_time/end_time'}), 400

    def is_off_value(val: str) -> bool:
        if not val:
            return True
        txt = str(val).strip().lower()
        return txt in ['off','vacation','training','']

    for employee in employees:
        sched = employee.schedule
        day_key = day.lower()
        shift_val = getattr(sched, day_key) if sched else None
        win = _shift_window(shift_val) if shift_val else None
        is_off = is_off_value(shift_val)
        overlap_minutes = 0
        available = True
        if win:
            s2, e2 = win
            overlap_minutes = max(0, min(r_em, e2) - max(r_sm, s2))
            available = overlap_minutes == 0
        elif is_off:
            # No shift means available, but mark off explicitly
            available = True
        emp_obj = {
            'id': employee.id,
            'employee_name': employee.name,
            'position': employee.position,
            'department': employee.department,
            'day': day_key,
            'requested_start': str(start_time),
            'requested_end': str(end_time),
            'requested_minutes': r_em - r_sm,
            'day_shift': shift_val or '',
            'is_off': is_off,
            'overlap_minutes': overlap_minutes,
            'status': 'off' if is_off else ('available' if available else 'overlap')
        }
        if include_all:
            results.append(emp_obj)
        else:
            if available:
                results.append(emp_obj)
    
    return jsonify(results)

@app.route('/api/schedule', methods=['GET'])
def get_schedules():
    department = request.args.get('department')
    query = Employee.query

    if department:
        query = query.filter_by(department=department)

    employees = query.all()
    
    # Debug log
    for emp in employees[:5]:  # Just log first 5 for brevity
        print(f"Schedule for {emp.name}: Position={emp.position}, Dept={emp.department}")
        if emp.schedule:
            print(f"  Monday: {emp.schedule.monday}")
    
    return jsonify([emp.to_dict() for emp in employees])

@app.route('/api/schedule/meta', methods=['GET', 'PATCH'])
def schedule_metadata():
    _ensure_schedule_column_meta()
    if request.method == 'GET':
        columns = ScheduleColumnMeta.query.order_by(ScheduleColumnMeta.sort_order).all()
        return jsonify([c.to_dict() for c in columns])

    data = request.json or {}
    updates = data if isinstance(data, list) else [data]
    valid_keys = {c.day_key: c for c in ScheduleColumnMeta.query.all()}
    changed = False
    for item in updates:
        day_key = (item.get('day_key') or '').lower()
        meta = valid_keys.get(day_key)
        if not meta:
            continue
        if 'display_name' in item and item['display_name']:
            meta.display_name = item['display_name'][:40]
            changed = True
        if 'subtitle' in item:
            meta.subtitle = (item['subtitle'] or '')[:40]
            changed = True
        if 'is_visible' in item:
            meta.is_visible = bool(item['is_visible'])
            changed = True
        if 'sort_order' in item and isinstance(item['sort_order'], int):
            meta.sort_order = item['sort_order']
            changed = True
    if changed:
        db.session.commit()
    return jsonify({'message': 'Columns updated successfully'})

@app.route('/api/schedule/columns/<day_key>', methods=['DELETE', 'POST'])
def manage_schedule_column(day_key):
    _ensure_schedule_column_meta()
    day_key = (day_key or '').lower()
    meta = ScheduleColumnMeta.query.get(day_key)
    if not meta:
        return jsonify({'error': 'Invalid column'}), 404
    valid_days = ['saturday','sunday','monday','tuesday','wednesday','thursday','friday']
    if day_key not in valid_days:
        return jsonify({'error': 'Unsupported column'}), 400

    if request.method == 'DELETE':
        meta.is_visible = False
        # Clear all schedule values for that day to effectively delete column content
        schedules = Schedule.query.all()
        for sched in schedules:
            if sched and hasattr(sched, day_key):
                setattr(sched, day_key, '')
        db.session.commit()
        return jsonify({'message': f'{day_key.capitalize()} column hidden and cleared'})
    else:
        meta.is_visible = True
        db.session.commit()
        return jsonify({'message': f'{day_key.capitalize()} column restored'})

@app.route('/api/tasks', methods=['GET'])
def get_tasks():
    tasks = Task.query.all()
    return jsonify([task.to_dict() for task in tasks])

@app.route('/api/tasks', methods=['POST'])
def create_task():
    data = request.json or {}
    required_fields = ['employee_id', 'task_name', 'day_of_week', 'start_time', 'end_time']
    for field in required_fields:
        if field not in data:
            return jsonify({'error': f'Missing required field: {field}'}), 400
    task = Task()
    task.employee_id = data['employee_id']
    task.task_name = data['task_name']
    task.day_of_week = data['day_of_week']
    task.start_time = data['start_time']
    task.end_time = data['end_time']
    task.required_skill = data.get('required_skill')
    db.session.add(task)
    db.session.commit()
    return jsonify({'message': 'Task created successfully', 'task': task.to_dict()})

@app.route('/api/tasks/<int:task_id>', methods=['DELETE'])
def delete_task(task_id):
    task = Task.query.get_or_404(task_id)
    db.session.delete(task)
    db.session.commit()
    return jsonify({'message': 'Task deleted successfully'})

@app.route('/api/employee/<int:employee_id>/schedule/<day>', methods=['PATCH'])
def update_employee_schedule(employee_id, day):
    data = request.json or {}
    shift_time = data.get('shift_time')
    
    # Validate day parameter
    valid_days = ['saturday', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday']
    if day.lower() not in valid_days:
        return jsonify({'error': f'Invalid day. Must be one of: {", ".join(valid_days)}'}), 400
    
    # Find the employee schedule
    schedule = Schedule.query.filter_by(employee_id=employee_id).first()
    if not schedule:
        return jsonify({'error': 'Employee schedule not found'}), 404
    
    # Update the schedule day
    setattr(schedule, day.lower(), shift_time)
    
    try:
        db.session.commit()
        return jsonify({'message': 'Schedule updated successfully'})
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': f'Error updating schedule: {str(e)}'}), 500

@app.route('/api/announcements', methods=['GET'])
def get_announcements():
    # Fetch all announcements from the database
    announcements = Announcement.query.order_by(Announcement.date.desc()).all()
    return jsonify([announcement.to_dict() for announcement in announcements])

@app.route('/api/announcements', methods=['POST'])
def create_announcement():
    data = request.json or {}
    required_fields = ['title', 'content', 'type']
    for field in required_fields:
        if field not in data:
            return jsonify({'error': f'Missing required field: {field}'}), 400
    announcement = Announcement()
    announcement.title = data['title']
    announcement.content = data['content']
    announcement.type = data['type']
    announcement.date = datetime.now().date()
    db.session.add(announcement)
    db.session.commit()
    return jsonify({'message': 'Announcement created successfully', 'announcement': announcement.to_dict()})

@app.route('/api/announcements/<int:announcement_id>', methods=['DELETE'])
def delete_announcement(announcement_id):
    announcement = Announcement.query.get_or_404(announcement_id)
    db.session.delete(announcement)
    db.session.commit()
    return jsonify({'message': 'Announcement deleted successfully'})

@app.route('/api/announcements/update', methods=['POST'])
def update_announcements():
    data = request.json or {}
    announcements_data = data.get('announcements', [])
    try:
        Announcement.query.delete()
        saved_announcements = []
        for announcement in announcements_data:
            try:
                if announcement.get('date'):
                    if '-' in announcement['date']:
                        announcement_date = datetime.strptime(announcement['date'], '%Y-%m-%d').date()
                    elif '/' in announcement['date']:
                        announcement_date = datetime.strptime(announcement['date'], '%m/%d/%Y').date()
                    else:
                        announcement_date = datetime.now().date()
                else:
                    announcement_date = datetime.now().date()
            except Exception as e:
                print(f"Error parsing date: {e}. Using current date instead.")
                announcement_date = datetime.now().date()
            new_announcement = Announcement()
            new_announcement.title = announcement['title']
            new_announcement.content = announcement['content']
            new_announcement.type = announcement['type']
            new_announcement.date = announcement_date
            db.session.add(new_announcement)
        db.session.commit()
        all_announcements = Announcement.query.all()
        return jsonify({
            'message': 'Announcements updated successfully',
            'announcements': [announcement.to_dict() for announcement in all_announcements]
        })
    except Exception as e:
        db.session.rollback()
        print(f"Error updating announcements: {str(e)}")
        print(traceback.format_exc())
        return jsonify({'error': f'Error updating announcements: {str(e)}'}), 500

@app.route('/api/admin/verify', methods=['POST'])
def verify_admin():
    data = request.json or {}
    password = data.get('password')
    if password == 'admin123':
        return jsonify({'authenticated': True})
    else:
        return jsonify({'authenticated': False}), 401

# --- Time Off APIs ---
@app.route('/api/timeoff', methods=['POST'])
def submit_timeoff():
    data = request.get_json() or {}
    required = ['employee_id','request_type','start_date','end_date']
    for f in required:
        if f not in data:
            return jsonify({'error': f'Missing {f}'}), 400
    req = TimeOffRequest(
        employee_id=data['employee_id'],
        request_type=data['request_type'],
        start_date=data['start_date'],
        end_date=data['end_date'],
        reason=data.get('reason','')
    )
    db.session.add(req)
    db.session.commit()
    return jsonify({'message':'Request submitted', 'request': req.to_dict()}), 201

@app.route('/api/timeoff', methods=['GET'])
def get_all_timeoff():
    include_expired = str(request.args.get('include_expired', '0')).lower() in ['1','true','yes']
    items = TimeOffRequest.query.all()
    if not include_expired:
        today = datetime.now().date()
        def _parse(d: str):
            try:
                return datetime.strptime(d, '%Y-%m-%d').date()
            except Exception:
                try:
                    return datetime.strptime(d, '%m/%d/%Y').date()
                except Exception:
                    return None
        filtered = []
        for it in items:
            end = _parse(it.end_date) if it.end_date else None
            # Hide only if we can parse and it's strictly in the past
            if end and end < today:
                continue
            filtered.append(it)
        items = filtered
    return jsonify([i.to_dict() for i in items])

@app.route('/api/timeoff/<int:req_id>', methods=['PATCH'])
def update_timeoff_status(req_id):
    data = request.get_json() or {}
    req = TimeOffRequest.query.get(req_id)
    if not req:
        return jsonify({'error':'Request not found'}), 404
    status = data.get('status')
    if status not in ['pending','approved','denied']:
        return jsonify({'error':'Invalid status'}), 400
    req.status = status
    db.session.commit()
    # notify placeholder
    emp = Employee.query.get(req.employee_id)
    to_addr = f"employee{emp.id}@example.com" if emp else "unknown@example.com"
    subject = f"Time Off Request {req.status.title()}"
    body = (
        f"Hello {emp.name if emp else ''},\n\n"
        f"Your {req.request_type.upper()} request from {req.start_date} to {req.end_date} has been {req.status.upper()}."
    )
    send_email(to_addr, subject, body)
    return jsonify({'message':'Status updated'})

@app.route('/api/timeoff/conflicts', methods=['GET'])
def check_timeoff_conflicts():
    employee_id = request.args.get('employee_id', type=int)
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    if not all([employee_id, start_date, end_date]):
        return jsonify({'error': 'Missing required parameters'}), 400
    emp = Employee.query.get(employee_id)
    if not emp or not emp.schedule:
        return jsonify({'conflicts': []})
    try:
        s = datetime.strptime(start_date, '%Y-%m-%d').date()
        e = datetime.strptime(end_date, '%Y-%m-%d').date()
    except Exception:
        return jsonify({'error': 'Dates must be YYYY-MM-DD'}), 400
    day_names = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']
    conflicts = []
    d = s
    while d <= e:
        day = day_names[d.weekday()]
        val = getattr(emp.schedule, day)
        if val and val.strip().lower() not in ['off','vacation','']:
            conflicts.append({'date': d.isoformat(), 'day': day, 'shift': val})
        d = d.fromordinal(d.toordinal()+1)
    return jsonify({'conflicts': conflicts})

# --- Predictive Insights ---
@app.route('/api/predictive-insights', methods=['GET'])
def get_predictive_insights():
    return jsonify(_compute_predictive_insights())

# --- Suggestions APIs ---
@app.route('/api/suggestions/generate', methods=['POST'])
def api_generate_suggestions():
    scope = request.args.get('scope', 'all')
    created = []
    if scope in ['all','coverage']:
        created += _generate_coverage_suggestions()
    if scope in ['all','burnout']:
        created += _generate_burnout_suggestions()
    return jsonify({'created': [s.to_dict() for s in created]})

@app.route('/api/suggestions', methods=['GET'])
def api_list_suggestions():
    status = request.args.get('status')
    q = Suggestion.query
    if status:
        q = q.filter_by(status=status)
    items = q.order_by(Suggestion.created_at.desc()).all()
    return jsonify([s.to_dict() for s in items])

@app.route('/api/suggestions/<int:sug_id>', methods=['PATCH'])
def api_update_suggestion(sug_id):
    data = request.get_json() or {}
    sug = Suggestion.query.get(sug_id)
    if not sug:
        return jsonify({'error':'Suggestion not found'}), 404
    status = data.get('status')
    if status not in ['pending','approved','denied']:
        return jsonify({'error':'Invalid status'}), 400
    sug.status = status
    db.session.commit()
    executed = None
    if status == 'approved' and sug.type == 'coverage_backfill' and sug.employee_id and sug.day_key and sug.start_time and sug.end_time:
        emp = Employee.query.get(sug.employee_id)
        if emp:
            task = Task(
                employee_id=emp.id,
                task_name='988 Coverage Backfill',
                day_of_week=_day_key_to_title(sug.day_key),
                start_time=sug.start_time,
                end_time=sug.end_time,
                required_skill='988/CRISIS'
            )
            db.session.add(task)
            db.session.commit()
            executed = {'task_id': task.id}
    return jsonify({'message':'Updated', 'suggestion': sug.to_dict(), 'executed': executed})

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    _ensure_daily_scheduler(app)
    app.run(host='0.0.0.0', port=8080, debug=True)
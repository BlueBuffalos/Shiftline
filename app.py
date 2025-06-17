from flask import Flask, render_template, request, jsonify
from flask_sqlalchemy import SQLAlchemy
import pandas as pd
import os
from datetime import datetime, time
import traceback
import re

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///schedule.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.secret_key = 'your-secret-key-here'

db = SQLAlchemy(app)

class Employee(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    position = db.Column(db.String(100))
    supervisor = db.Column(db.String(100))
    department = db.Column(db.String(100))
    schedule = db.relationship('Schedule', backref='employee', uselist=False)
    tasks = db.relationship('Task', backref='employee', lazy=True)

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
        Task.query.delete()
        Schedule.query.delete()
        Employee.query.delete()
        db.session.commit()

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

@app.route('/api/employees', methods=['GET'])
def get_employees():
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

@app.route('/api/employees/available', methods=['GET'])
def get_available_employees():
    day = request.args.get('day')
    start_time = request.args.get('start_time')
    end_time = request.args.get('end_time')
    position = request.args.get('position')
    
    # Basic validation
    if not all([day, start_time, end_time]):
        return jsonify({'error': 'Missing required parameters'}), 400
        
    # Find employees with matching position and availability
    available_employees = []
    
    query = Employee.query
    if position:
        query = query.filter_by(position=position)
    
    employees = query.all()
    
    for employee in employees:
        if employee.schedule and employee.schedule.is_available(day, start_time, end_time):
            available_employees.append(employee.to_dict())
    
    return jsonify(available_employees)

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

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    app.run(host='0.0.0.0', port=8080, debug=True)
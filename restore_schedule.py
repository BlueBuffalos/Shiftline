import csv
from app import db, Employee, Schedule

def restore_schedule():
    with open('Cleaned_Schedule_Data.csv', 'r') as file:
        reader = csv.DictReader(file)
        for row in reader:
            if row['Name'] and row['Position']:
                employee = Employee(
                    name=row['Name'],
                    position=row['Position'],
                    supervisor=row['Supervisor']
                )
                db.session.add(employee)
                db.session.flush()  # Get the employee ID

                schedule = Schedule(
                    employee_id=employee.id,
                    saturday=row['Saturday'],
                    sunday=row['Sunday'],
                    monday=row['Monday'],
                    tuesday=row['Tuesday'],
                    wednesday=row['Wednesday'],
                    thursday=row['Thursday'],
                    friday=row['Friday']
                )
                db.session.add(schedule)
        db.session.commit()

if __name__ == '__main__':
    restore_schedule()

from app import app, db, Employee, Schedule
from datetime import datetime, time

def init_db():
    with app.app_context():
        # Drop all existing tables and recreate them
        db.drop_all()
        db.create_all()
        print("Database initialized with new schema!")

if __name__ == '__main__':
    init_db()
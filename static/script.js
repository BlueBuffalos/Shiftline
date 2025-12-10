document.addEventListener('DOMContentLoaded', function() {
    const uploadForm = document.getElementById('uploadForm');
    const departmentSelect = document.getElementById('departmentSelect');
    const scheduleTableBody = document.getElementById('scheduleTableBody');
    const employeeSelect = document.getElementById('employeeSelect');
    const requiredSkillSelect = document.getElementById('requiredSkill');
    const positionFilter = document.getElementById('positionFilter');
    const taskForm = document.getElementById('taskForm');
    const tasksTableBody = document.getElementById('tasksTableBody');
    const availabilityForm = document.getElementById('availabilityForm');
    const availableEmployeesList = document.getElementById('availableEmployeesList');
    const adminAccessBtn = document.getElementById('adminAccessBtn');
    const adminLoginModal = new bootstrap.Modal(document.getElementById('adminLoginModal'));
    const adminLoginBtn = document.getElementById('adminLoginBtn');
    const adminPasswordInput = document.getElementById('adminPassword');
    const adminLoginError = document.getElementById('adminLoginError');
    const adminTickerControls = document.getElementById('adminTickerControls');
    const editTickerBtn = document.getElementById('editTickerBtn');
    const tickerEditModal = new bootstrap.Modal(document.getElementById('tickerEditModal'));
    const addTickerItemBtn = document.getElementById('addTickerItemBtn');
    const tickerItemsContainer = document.getElementById('tickerItemsContainer');
    const saveTickerBtn = document.getElementById('saveTickerBtn');
    const tickerContent = document.getElementById('tickerContent');
    const scheduleAdminPanel = document.getElementById('scheduleAdminPanel');
    const addEmployeeForm = document.getElementById('addEmployeeForm');
    const newEmployeeName = document.getElementById('newEmployeeName');
    const newEmployeePosition = document.getElementById('newEmployeePosition');
    const newEmployeeDepartment = document.getElementById('newEmployeeDepartment');
    const newEmployeeSupervisor = document.getElementById('newEmployeeSupervisor');
    const columnEditorList = document.getElementById('columnEditorList');
    const restoreColumnsBtn = document.getElementById('restoreColumnsBtn');

    // Initialize Bootstrap tabs
    const triggerTabList = [].slice.call(document.querySelectorAll('#myTab button'));
    triggerTabList.forEach(function(triggerEl) {
        const tabTrigger = new bootstrap.Tab(triggerEl);
        
        triggerEl.addEventListener('click', function(event) {
                event.preventDefault();
                tabTrigger.show();
        });
    });
    
        // Store assigned tasks globally so we can access them in multiple functions
    let assignedTasks = [];
    let isAdminLoggedIn = false;
    const DEFAULT_DAY_ORDER = ['saturday','sunday','monday','tuesday','wednesday','thursday','friday'];
    let scheduleColumnMetaAll = [];
    let scheduleColumnMetaVisible = [];

    // Mock admin password - in a real app this would be checked server-side
    const ADMIN_PASSWORD = 'admin123';

    // Store announcements (will be loaded from the server)
    let announcements = [];
    
    // Load announcements from the server when page loads
    function loadAnnouncements() {
        fetch('/api/announcements')
            .then(response => response.json())
            .then(data => {
                announcements = data;
                renderTicker();
            })
            .catch(error => {
                console.error('Error loading announcements:', error);
                // Display a default message if we can't load announcements
                tickerContent.innerHTML = '<div class="text-muted">Unable to load announcements.</div>';
            });
    }

    function showTransientAlert(message, type = 'success', duration = 4000) {
        const host = document.querySelector('.container-fluid') || document.body;
        if (!host) {
            window.alert(message);
            return;
        }
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type} alert-dismissible fade show admin-feedback`;
    alertDiv.setAttribute('role', 'alert');
        alertDiv.innerHTML = `
            ${message}
            <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
        `;
        host.prepend(alertDiv);
        if (duration > 0) {
            setTimeout(() => {
                try {
                    const bsAlert = bootstrap.Alert.getOrCreateInstance(alertDiv);
                    bsAlert.close();
                } catch (err) {
                    if (alertDiv && alertDiv.parentNode) {
                        alertDiv.parentNode.removeChild(alertDiv);
                    }
                }
            }, duration);
        }
    }

    // Function to toggle edit permissions based on admin status
    function updateEditPermissions() {
        const editButtons = document.querySelectorAll('.add-shift-btn, .edit-shift-btn, .delete-task');
        const forms = document.querySelectorAll('#taskForm, #uploadForm');
        const submitButtons = document.querySelectorAll('button[type="submit"]');
        
        if (isAdminLoggedIn) {
            // Enable editing for admins
            editButtons.forEach(btn => {
                btn.disabled = false;
                btn.style.display = 'inline-block';
            });
            
            forms.forEach(form => {
                form.querySelectorAll('input, select, textarea').forEach(input => {
                    input.disabled = false;
                });
            });
            
            submitButtons.forEach(btn => {
                btn.disabled = false;
            });
            
            // Show admin controls
            document.querySelectorAll('.shift-actions, #adminTickerControls').forEach(el => {
                el.style.display = 'block';
            });
            
            // Add a visual indicator that admin mode is active
            document.body.classList.add('admin-mode');
            if (scheduleAdminPanel) {
                scheduleAdminPanel.style.display = 'flex';
            }
        } else {
            // Disable editing for non-admins
            editButtons.forEach(btn => {
                btn.disabled = true;
                btn.style.display = 'none';
            });
            
            forms.forEach(form => {
                form.querySelectorAll('input, select, textarea').forEach(input => {
                    input.disabled = true;
                });
            });
            
            submitButtons.forEach(btn => {
                btn.disabled = true;
            });
            
            // Hide admin controls
            document.querySelectorAll('.shift-actions, #adminTickerControls').forEach(el => {
                el.style.display = 'none';
            });
            
            // Remove admin mode indicator
            document.body.classList.remove('admin-mode');
            if (scheduleAdminPanel) {
                scheduleAdminPanel.style.display = 'none';
            }
        }
    }

    const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"];

    function getScheduleStartDate(reference = new Date()) {
        const start = new Date(reference);
        const dayOfWeek = reference.getDay(); // 0=Sunday ... 6=Saturday
        const daysToGoBack = dayOfWeek === 6 ? 0 : dayOfWeek + 1;
        start.setDate(reference.getDate() - daysToGoBack);
        start.setHours(0, 0, 0, 0);
        return start;
    }

    function getVisibleDayKeys() {
        if (scheduleColumnMetaVisible.length) {
            return scheduleColumnMetaVisible.map(col => col.day_key);
        }
        return DEFAULT_DAY_ORDER;
    }

    function loadScheduleMeta() {
        return fetch('/api/schedule/meta')
            .then(response => response.json())
            .then(meta => {
                const sorted = meta.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
                scheduleColumnMetaAll = sorted;
                scheduleColumnMetaVisible = sorted.filter(col => col.is_visible !== false);
                renderScheduleHeaders();
                renderColumnAdmin(sorted);
            })
            .catch(error => {
                console.error('Error loading schedule metadata:', error);
                scheduleColumnMetaAll = [];
                scheduleColumnMetaVisible = [];
            });
    }

    function renderScheduleHeaders() {
        const dayHeaderRow = document.getElementById('dayHeaderRow');
        const dateRow = document.getElementById('dateRow');
        const currentMonthEl = document.getElementById('currentMonth');
        if (!dayHeaderRow || !dateRow) {
            return;
        }

        while (dayHeaderRow.children.length > 2) {
            dayHeaderRow.removeChild(dayHeaderRow.lastChild);
        }
        dateRow.innerHTML = '';

        const today = new Date();
        const weekStart = getScheduleStartDate(today);
        const visibleColumns = scheduleColumnMetaVisible.length
            ? scheduleColumnMetaVisible
            : DEFAULT_DAY_ORDER.map((day, idx) => ({
                day_key: day,
                display_name: day.charAt(0).toUpperCase() + day.slice(1),
                subtitle: '',
                is_visible: true,
                sort_order: idx
            }));

        visibleColumns.forEach(col => {
            const th = document.createElement('th');
            th.dataset.dayKey = col.day_key;
            th.textContent = col.display_name || col.day_key.charAt(0).toUpperCase() + col.day_key.slice(1);
            dayHeaderRow.appendChild(th);

            const dateCell = document.createElement('th');
            dateCell.dataset.dayKey = col.day_key;
            let subtitle = col.subtitle || '';
            if (!subtitle) {
                const defaultIndex = DEFAULT_DAY_ORDER.indexOf(col.day_key);
                if (defaultIndex >= 0) {
                    const date = new Date(weekStart);
                    date.setDate(weekStart.getDate() + defaultIndex);
                    subtitle = String(date.getDate());
                    if (
                        date.getDate() === today.getDate() &&
                        date.getMonth() === today.getMonth() &&
                        date.getFullYear() === today.getFullYear()
                    ) {
                        dateCell.classList.add('current-date');
                    }
                }
            }
            dateCell.textContent = subtitle;
            dateRow.appendChild(dateCell);
        });

        if (currentMonthEl) {
            if (!visibleColumns.length) {
                currentMonthEl.textContent = '';
            } else {
                const endDate = new Date(weekStart);
                const lastOffset = DEFAULT_DAY_ORDER.indexOf(visibleColumns[visibleColumns.length - 1].day_key);
                const safeOffset = lastOffset >= 0 ? lastOffset : visibleColumns.length - 1;
                endDate.setDate(weekStart.getDate() + safeOffset);

                let monthDisplay = '';
                if (weekStart.getMonth() === endDate.getMonth()) {
                    monthDisplay = `${MONTH_NAMES[weekStart.getMonth()]} ${weekStart.getFullYear()}`;
                } else {
                    monthDisplay = `${MONTH_NAMES[weekStart.getMonth()]} - ${MONTH_NAMES[endDate.getMonth()]} ${endDate.getFullYear()}`;
                    if (weekStart.getFullYear() !== endDate.getFullYear()) {
                        monthDisplay = `${MONTH_NAMES[weekStart.getMonth()]} ${weekStart.getFullYear()} - ${MONTH_NAMES[endDate.getMonth()]} ${endDate.getFullYear()}`;
                    }
                }
                currentMonthEl.textContent = `(${monthDisplay})`;
            }
        }
    }

    function renderColumnAdmin(metaList) {
        if (!columnEditorList) {
            return;
        }
        columnEditorList.innerHTML = '';
        const frag = document.createDocumentFragment();
        metaList.forEach(col => {
            const item = document.createElement('div');
            item.className = `column-editor-item ${col.is_visible ? '' : 'disabled'}`;
            item.dataset.dayKey = col.day_key;
            item.innerHTML = `
                <div class="d-flex justify-content-between align-items-center mb-2">
                    <div>
                        <strong>${col.display_name || col.day_key.charAt(0).toUpperCase() + col.day_key.slice(1)}</strong>
                        <span class="badge bg-light text-dark ms-2">${col.day_key}</span>
                    </div>
                    <div class="form-check form-switch">
                        <input class="form-check-input column-visibility-toggle" type="checkbox" ${col.is_visible ? 'checked' : ''}>
                        <label class="form-check-label">Visible</label>
                    </div>
                </div>
                <div class="row g-2 mb-2">
                    <div class="col-6">
                        <label class="form-label form-label-sm mb-1">Display Name</label>
                        <input class="form-control form-control-sm column-display-input" value="${col.display_name || ''}">
                    </div>
                    <div class="col-6">
                        <label class="form-label form-label-sm mb-1">Subtitle / Date</label>
                        <input class="form-control form-control-sm column-subtitle-input" value="${col.subtitle || ''}">
                    </div>
                </div>
                <div class="column-editor-actions">
                    <button type="button" class="btn btn-sm btn-primary save-column-btn">Save</button>
                    <button type="button" class="btn btn-sm btn-outline-danger clear-column-btn">Clear</button>
                </div>
            `;
            frag.appendChild(item);
        });
        columnEditorList.appendChild(frag);
        attachColumnAdminListeners();
    }

    function updateColumnMeta(dayKey, payload) {
        const body = Array.isArray(payload) ? payload : [{ day_key: dayKey, ...payload }];
        return fetch('/api/schedule/meta', {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body.length === 1 ? body[0] : body)
        }).then(response => {
            if (!response.ok) {
                throw new Error('Failed to update column');
            }
            return response.json();
        });
    }

    function reloadScheduleAfterMeta() {
        return loadScheduleMeta().then(() => {
            loadSchedule();
        });
    }

    function attachColumnAdminListeners() {
        if (!columnEditorList) {
            return;
        }
        columnEditorList.querySelectorAll('.column-visibility-toggle').forEach(toggle => {
            toggle.addEventListener('change', function() {
                const item = this.closest('.column-editor-item');
                const dayKey = item.dataset.dayKey;
                const isVisible = this.checked;
                updateColumnMeta(dayKey, { is_visible: isVisible })
                    .then(() => reloadScheduleAfterMeta())
                    .catch(err => {
                        console.error('Error updating column visibility:', err);
                        this.checked = !isVisible;
                    });
            });
        });

        columnEditorList.querySelectorAll('.save-column-btn').forEach(button => {
            button.addEventListener('click', function() {
                const item = this.closest('.column-editor-item');
                const dayKey = item.dataset.dayKey;
                const displayInput = item.querySelector('.column-display-input');
                const subtitleInput = item.querySelector('.column-subtitle-input');
                updateColumnMeta(dayKey, {
                    display_name: displayInput.value,
                    subtitle: subtitleInput.value
                }).then(() => reloadScheduleAfterMeta())
                .catch(err => {
                    console.error('Error saving column metadata:', err);
                    alert('Unable to save column updates.');
                });
            });
        });

        columnEditorList.querySelectorAll('.clear-column-btn').forEach(button => {
            button.addEventListener('click', function() {
                const item = this.closest('.column-editor-item');
                const dayKey = item.dataset.dayKey;
                if (!confirm(`Clear all shifts in ${dayKey.toUpperCase()}? This hides the column until restored.`)) {
                    return;
                }
                fetch(`/api/schedule/columns/${dayKey}`, { method: 'DELETE' })
                    .then(response => {
                        if (!response.ok) {
                            throw new Error('Failed to clear column');
                        }
                        return response.json();
                    })
                    .then(() => reloadScheduleAfterMeta())
                    .catch(err => {
                        console.error('Error clearing column:', err);
                        alert('Unable to clear column.');
                    });
            });
        });
    }

    // Load and display schedule
    function loadSchedule() {
        const department = departmentSelect.value;
        const dayKeys = getVisibleDayKeys();
        const totalColumns = 2 + dayKeys.length;
        
        // First fetch the regular schedule
        fetch(`/api/schedule?department=${department}`)
            .then(response => response.json())
            .then(schedules => {
                console.log('Fetched schedules:', schedules); // Debug log
                // Then fetch all tasks to overlay on the schedule
                return fetch('/api/tasks')
                    .then(response => response.json())
                    .then(tasks => {
                        console.log('Fetched tasks:', tasks); // Debug log
                        // Store tasks globally
                        assignedTasks = tasks;
                        
                        // Clear current schedule
                        scheduleTableBody.innerHTML = '';

                        // Define department order
                        const departmentOrder = [
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
                        ];

                        // Department to CSS class mapping
                        const deptClassMap = {
                            "HELPLINE LEADERSHIP": "dept-helpline-leadership",
                            "TEAM LEADERS/COORDINATORS/SPECIALISTS": "dept-team-leaders",
                            "211 HELPLINE": "dept-211-helpline",
                            "988/CRISIS": "dept-988-crisis",
                            "CARE COORDINATORS/PEER SPECIALISTS": "dept-care-coordinators",
                            "CHAT/EMAIL/TEXT": "dept-chat-email-text",
                            "COURT/COMMUNITY RELATIONS": "dept-court-community",
                            "ELC ANSWERING SERVICE": "dept-elc-answering",
                            "TOUCHLINE": "dept-touchline",
                            "AVAILABLE SHIFTS": "dept-available-shifts"
                        };

                        // Group employees by department
                        const schedulesByDept = {};
                        departmentOrder.forEach(dept => {
                            schedulesByDept[dept] = [];
                        });

                        // Add employees to their departments
                        schedules.forEach(schedule => {
                            const dept = schedule.department || "Other";
                            if (departmentOrder.includes(dept)) {
                                schedulesByDept[dept].push(schedule);
                            } else {
                                // If department not in our predefined list, create it
                                if (!schedulesByDept[dept]) {
                                    schedulesByDept[dept] = [];
                                }
                                schedulesByDept[dept].push(schedule);
                            }
                        });

                        // Display schedules in the specified department order
                        departmentOrder.forEach(dept => {
                            if (schedulesByDept[dept] && schedulesByDept[dept].length > 0) {
                                // Add department header
                                const deptHeaderRow = document.createElement('tr');
                                deptHeaderRow.className = `table-primary dept-header ${deptClassMap[dept] || ''}`;
                                deptHeaderRow.innerHTML = `
                                    <td colspan="${totalColumns}"><strong>${dept}</strong></td>
                                `;
                                scheduleTableBody.appendChild(deptHeaderRow);

                                // Add employees in this department
                                schedulesByDept[dept].forEach(schedule => {
                                    const row = document.createElement('tr');
                                    // Apply department color class to employee rows
                                    row.className = deptClassMap[dept] || '';
                                    row.dataset.employeeId = schedule.id; // Store employee ID for editing
                                    
                                    // Create base schedule cells with regular shifts
                                    const dayColumns = {
                                        'saturday': schedule.saturday || '',
                                        'sunday': schedule.sunday || '',
                                        'monday': schedule.monday || '',
                                        'tuesday': schedule.tuesday || '',
                                        'wednesday': schedule.wednesday || '',
                                        'thursday': schedule.thursday || '',
                                        'friday': schedule.friday || ''
                                    };
                                    
                                    // Add task assignments to each day's schedule
                                    // First filter tasks for this employee
                                    const employeeTasks = tasks.filter(task => task.employee_id == schedule.id);
                                    
                                    // Group tasks by day
                                    const tasksByDay = {
                                        'Monday': [], 'Tuesday': [], 'Wednesday': [], 
                                        'Thursday': [], 'Friday': [], 'Saturday': [], 'Sunday': []
                                    };
                                    
                                    employeeTasks.forEach(task => {
                                        tasksByDay[task.day_of_week].push(task);
                                    });
                                    
                                    // Build the row cells
                                    const employeeCellContent = `
                                        <div class="d-flex justify-content-between align-items-center gap-2">
                                            <span class="employee-name">${schedule.employee_name}</span>
                                            ${isAdminLoggedIn ? `<button class="btn btn-sm btn-outline-danger delete-employee-btn" data-employee-id="${schedule.id}" data-employee-name="${schedule.employee_name}" title="Remove employee"><i class="fas fa-trash"></i></button>` : ''}
                                        </div>`;
                                    let rowHTML = `
                                        <td>${employeeCellContent}</td>
                                        <td>${schedule.position || ''}</td>
                                    `;
                                    
                                    // Create day cells with edit capability
                                    dayKeys.forEach(day => {
                                        // Build the cell content
                                        let cellContent = dayColumns[day];
                                        
                                        // Add edit button if there's content
                                        let editButton = '';
                                        if (cellContent) {
                                            editButton = `<button class="btn btn-sm btn-outline-secondary edit-shift-btn" 
                                                data-day="${day}" title="Edit shift"><i class="fas fa-pencil-alt"></i></button>`;
                                        } else {
                                            editButton = `<button class="btn btn-sm btn-outline-primary add-shift-btn" 
                                                data-day="${day}" title="Add shift"><i class="fas fa-plus"></i></button>`;
                                        }
                                        
                                        // Add tasks if any
                                        const dayCapitalized = day.charAt(0).toUpperCase() + day.slice(1);
                                        if (tasksByDay[dayCapitalized] && tasksByDay[dayCapitalized].length > 0) {
                                            const tasksList = tasksByDay[dayCapitalized].map(task => 
                                                `<div class="task-item" style="background-color: #f8d7da; padding: 2px 5px; margin-top: 5px; border-radius: 3px;">
                                                    <strong>${task.task_name}</strong>: ${task.start_time}-${task.end_time}
                                                </div>`
                                            ).join('');

                                            if (cellContent) {
                                                cellContent += '<hr style="margin: 5px 0">' + tasksList;
                                            } else {
                                                cellContent = tasksList;
                                            }
                                        }
                                        
                                        // Create the cell with edit controls
                                        rowHTML += `
                                            <td class="schedule-cell" data-day="${day}" data-employee-id="${schedule.id}">
                                                <div class="d-flex justify-content-between align-items-start">
                                                    <div class="shift-content">${cellContent || ''}</div>
                                                    <div class="shift-actions">${editButton}</div>
                                                </div>
                                            </td>
                                        `;
                                    });
                                    
                                    row.innerHTML = rowHTML;
                                    scheduleTableBody.appendChild(row);
                                });
                            }
                        });

                        // Handle departments not in our predefined list
                        Object.keys(schedulesByDept).forEach(dept => {
                            if (!departmentOrder.includes(dept) && dept !== "Other" && schedulesByDept[dept].length > 0) {
                                // Add department header
                                const deptHeaderRow = document.createElement('tr');
                                deptHeaderRow.className = 'table-primary dept-header';
                                deptHeaderRow.innerHTML = `
                                    <td colspan="${totalColumns}"><strong>${dept}</strong></td>
                                `;
                                scheduleTableBody.appendChild(deptHeaderRow);

                                // Add employees in this department with tasks and edit controls
                                schedulesByDept[dept].forEach(schedule => {
                                    const row = document.createElement('tr');
                                    row.dataset.employeeId = schedule.id;
                                    
                                    // Apply same rendering logic as above with edit controls
                                    const dayColumns = {
                                        'saturday': schedule.saturday || '',
                                        'sunday': schedule.sunday || '',
                                        'monday': schedule.monday || '',
                                        'tuesday': schedule.tuesday || '',
                                        'wednesday': schedule.wednesday || '',
                                        'thursday': schedule.thursday || '',
                                        'friday': schedule.friday || ''
                                    };
                                    
                                    const employeeTasks = tasks.filter(task => task.employee_id == schedule.id);
                                    
                                    const tasksByDay = {
                                        'Monday': [], 'Tuesday': [], 'Wednesday': [], 
                                        'Thursday': [], 'Friday': [], 'Saturday': [], 'Sunday': []
                                    };
                                    
                                    employeeTasks.forEach(task => {
                                        tasksByDay[task.day_of_week].push(task);
                                    });
                                    
                                    // Build the row cells
                                    const employeeCellContent = `
                                        <div class="d-flex justify-content-between align-items-center gap-2">
                                            <span class="employee-name">${schedule.employee_name}</span>
                                            ${isAdminLoggedIn ? `<button class="btn btn-sm btn-outline-danger delete-employee-btn" data-employee-id="${schedule.id}" data-employee-name="${schedule.employee_name}" title="Remove employee"><i class="fas fa-trash"></i></button>` : ''}
                                        </div>`;
                                    let rowHTML = `
                                        <td>${employeeCellContent}</td>
                                        <td>${schedule.position || ''}</td>
                                    `;
                                    
                                    // Create day cells with edit capability
                                    dayKeys.forEach(day => {
                                        // Build the cell content
                                        let cellContent = dayColumns[day];
                                        
                                        // Add edit button if there's content
                                        let editButton = '';
                                        if (cellContent) {
                                            editButton = `<button class="btn btn-sm btn-outline-secondary edit-shift-btn" 
                                                data-day="${day}" title="Edit shift"><i class="fas fa-pencil-alt"></i></button>`;
                                        } else {
                                            editButton = `<button class="btn btn-sm btn-outline-primary add-shift-btn" 
                                                data-day="${day}" title="Add shift"><i class="fas fa-plus"></i></button>`;
                                        }
                                        
                                        // Add tasks if any
                                        const dayCapitalized = day.charAt(0).toUpperCase() + day.slice(1);
                                        if (tasksByDay[dayCapitalized] && tasksByDay[dayCapitalized].length > 0) {
                                            const tasksList = tasksByDay[dayCapitalized].map(task => 
                                                `<div class="task-item" style="background-color: #f8d7da; padding: 2px 5px; margin-top: 5px; border-radius: 3px;">
                                                    <strong>${task.task_name}</strong>: ${task.start_time}-${task.end_time}
                                                </div>`
                                            ).join('');
                                            
                                            if (cellContent) {
                                                cellContent += '<hr style="margin: 5px 0">' + tasksList;
                                            } else {
                                                cellContent = tasksList;
                                            }
                                        }
                                        
                                        // Create the cell with edit controls
                                        rowHTML += `
                                            <td class="schedule-cell" data-day="${day}" data-employee-id="${schedule.id}">
                                                <div class="d-flex justify-content-between align-items-start">
                                                    <div class="shift-content">${cellContent || ''}</div>
                                                    <div class="shift-actions">${editButton}</div>
                                                </div>
                                            </td>
                                        `;
                                    });
                                    
                                    row.innerHTML = rowHTML;
                                    scheduleTableBody.appendChild(row);
                                });
                            }
                        });
                        
                        // Add event listeners for shift editing
                        addShiftEditListeners();
                        attachEmployeeDeleteHandlers();
                    });
            })
            .catch(error => {
                console.error('Error loading schedule:', error);
                alert('Error loading schedule. Please try again.');
            });
    }
    
    // Function to add event listeners for shift editing
    function addShiftEditListeners() {
        // Add shift button listeners
        document.querySelectorAll('.add-shift-btn').forEach(button => {
            button.addEventListener('click', function(e) {
                e.stopPropagation();
                const day = this.dataset.day;
                const cell = this.closest('.schedule-cell');
                const employeeId = cell.dataset.employeeId;
                showShiftEditor(cell, day, employeeId, null);
            });
        });
        
        // Edit shift button listeners
        document.querySelectorAll('.edit-shift-btn').forEach(button => {
            button.addEventListener('click', function(e) {
                e.stopPropagation();
                const day = this.dataset.day;
                const cell = this.closest('.schedule-cell');
                const employeeId = cell.dataset.employeeId;
                const shiftContent = cell.querySelector('.shift-content').textContent.trim();
                showShiftEditor(cell, day, employeeId, shiftContent);
            });
        });
    }
    
    function attachEmployeeDeleteHandlers() {
        if (!isAdminLoggedIn) {
            return;
        }
        document.querySelectorAll('.delete-employee-btn').forEach(button => {
            button.addEventListener('click', function(e) {
                e.preventDefault();
                const employeeId = this.dataset.employeeId;
                const employeeName = this.dataset.employeeName || '';
                if (!employeeId) {
                    return;
                }
                if (!confirm(`Remove ${employeeName || 'this employee'} and clear their schedule?`)) {
                    return;
                }
                fetch(`/api/employees/${employeeId}`, {
                    method: 'DELETE'
                })
                .then(response => {
                    if (!response.ok) {
                        throw new Error('Failed to delete employee');
                    }
                    return response.json();
                })
                .then(() => {
                    loadSchedule();
                    loadEmployees();
                    loadDepartments();
                    loadPositions();
                })
                .catch(error => {
                    console.error('Error deleting employee:', error);
                    alert('Unable to delete employee.');
                });
            });
        });
    }

    function handleAddEmployeeSubmit(event) {
        event.preventDefault();
        if (!isAdminLoggedIn) {
            showTransientAlert('Admin access required to add employees.', 'warning');
            return;
        }
        if (!addEmployeeForm) {
            return;
        }
        const name = newEmployeeName ? newEmployeeName.value.trim() : '';
        const position = newEmployeePosition ? newEmployeePosition.value.trim() : '';
        const department = newEmployeeDepartment ? newEmployeeDepartment.value.trim() : '';
        const supervisorRaw = newEmployeeSupervisor ? newEmployeeSupervisor.value.trim() : '';
        if (!name) {
            showTransientAlert('Please enter the employee name before saving.', 'warning');
            if (newEmployeeName) {
                newEmployeeName.focus();
            }
            return;
        }
        const submitBtn = addEmployeeForm.querySelector('button[type="submit"]');
        if (submitBtn) {
            submitBtn.disabled = true;
        }
        const payload = {
            name: name,
            position: position,
            department: department,
            supervisor: supervisorRaw || null
        };
        fetch('/api/employees', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        })
        .then(response => response.json().then(json => ({ ok: response.ok, json })))
        .then(({ ok, json }) => {
            if (!ok || (json && json.error)) {
                throw new Error(json && json.error ? json.error : 'Unable to add employee');
            }
            showTransientAlert('Employee added successfully.', 'success');
            addEmployeeForm.reset();
            loadEmployees();
            loadSchedule();
            loadDepartments();
            loadPositions();
        })
        .catch(error => {
            console.error('Error adding employee:', error);
            showTransientAlert(error.message || 'Error adding employee.', 'danger', 6000);
        })
        .finally(() => {
            if (submitBtn) {
                submitBtn.disabled = false;
            }
        });
    }

    function handleRestoreHiddenColumns(event) {
        if (event) {
            event.preventDefault();
        }
        if (!isAdminLoggedIn) {
            showTransientAlert('Admin access required to restore columns.', 'warning');
            return;
        }
        if (!restoreColumnsBtn) {
            return;
        }
        const hiddenColumns = scheduleColumnMetaAll.filter(col => col && col.is_visible === false);
        if (!hiddenColumns.length) {
            showTransientAlert('No hidden columns to restore.', 'info');
            return;
        }
        restoreColumnsBtn.disabled = true;
        Promise.all(hiddenColumns.map(col => {
            return fetch(`/api/schedule/columns/${col.day_key}`, { method: 'POST' })
                .then(response => {
                    if (!response.ok) {
                        throw new Error(`Failed to restore ${col.day_key}`);
                    }
                });
        }))
        .then(() => reloadScheduleAfterMeta())
        .then(() => {
            showTransientAlert('Hidden columns restored.', 'success');
        })
        .catch(error => {
            console.error('Error restoring columns:', error);
            showTransientAlert('Unable to restore all columns. Please try again.', 'danger', 6000);
        })
        .finally(() => {
            restoreColumnsBtn.disabled = false;
        });
    }

    // Function to show the shift editor in a cell
    function showShiftEditor(cell, day, employeeId, currentShift) {
        // Check if user has admin access, if not, don't allow editing
        if (!isAdminLoggedIn) {
            // Show a message about needing admin access
            const adminAlert = document.createElement('div');
            adminAlert.className = 'alert alert-warning alert-dismissible fade show';
            adminAlert.innerHTML = `
                <strong>Admin access required.</strong> Please log in as admin to edit schedules.
                <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
            `;
            document.querySelector('.container-fluid').prepend(adminAlert);
            
            // Auto-dismiss the alert after 3 seconds
            setTimeout(() => {
                const bsAlert = new bootstrap.Alert(adminAlert);
                bsAlert.close();
            }, 3000);
            
            return; // Exit function early
        }

        // Create the time picker format with more granular time options
        const timeOptions = [
            '', 
            '12a', '12:15a', '12:30a', '12:45a',
            '1a', '1:15a', '1:30a', '1:45a', 
            '2a', '2:15a', '2:30a', '2:45a',
            '3a', '3:15a', '3:30a', '3:45a',
            '4a', '4:15a', '4:30a', '4:45a',
            '5a', '5:15a', '5:30a', '5:45a',
            '6a', '6:15a', '6:30a', '6:45a',
            '7a', '7:15a', '7:30a', '7:45a',
            '8a', '8:15a', '8:30a', '8:45a',
            '9a', '9:15a', '9:30a', '9:45a',
            '10a', '10:15a', '10:30a', '10:45a',
            '11a', '11:15a', '11:30a', '11:45a',
            '12p', '12:15p', '12:30p', '12:45p',
            '1p', '1:15p', '1:30p', '1:45p',
            '2p', '2:15p', '2:30p', '2:45p',
            '3p', '3:15p', '3:30p', '3:45p',
            '4p', '4:15p', '4:30p', '4:45p',
            '5p', '5:15p', '5:30p', '5:45p',
            '6p', '6:15p', '6:30p', '6:45p',
            '7p', '7:15p', '7:30p', '7:45p',
            '8p', '8:15p', '8:30p', '8:45p',
            '9p', '9:15p', '9:30p', '9:45p',
            '10p', '10:15p', '10:30p', '10:45p',
            '11p', '11:15p', '11:30p', '11:45p'
        ];
        
        // Parse current shift time if exists
        let startTime = '';
        let endTime = '';
        let isOff = false;
        let isVacation = false;
        
        if (currentShift) {
            if (currentShift.toLowerCase() === 'off') {
                isOff = true;
            } else if (currentShift.toLowerCase() === 'vacation') {
                isVacation = true;
            } else {
                const timeParts = currentShift.split('-');
                if (timeParts.length === 2) {
                    startTime = timeParts[0].trim();
                    endTime = timeParts[1].trim();
                }
            }
        }
        
        // Create the editor HTML
        const editorHTML = `
            <div class="shift-editor p-2 border rounded bg-light">
                <div class="special-options mb-2">
                    <div class="form-check form-check-inline">
                        <input class="form-check-input off-check" type="checkbox" id="off-${day}" ${isOff ? 'checked' : ''}>
                        <label class="form-check-label" for="off-${day}">OFF</label>
                    </div>
                    <div class="form-check form-check-inline">
                        <input class="form-check-input vacation-check" type="checkbox" id="vacation-${day}" ${isVacation ? 'checked' : ''}>
                        <label class="form-check-label" for="vacation-${day}">Vacation</label>
                    </div>
                </div>
                <div class="regular-shift-inputs ${isOff || isVacation ? 'd-none' : ''}">
                    <div class="form-row mb-2">
                        <div class="col">
                            <label class="form-label form-label-sm">Start Time</label>
                            <select class="form-select form-select-sm start-time-select">
                                ${timeOptions.map(time => 
                                    `<option value="${time}" ${time === startTime ? 'selected' : ''}>${time}</option>`
                                ).join('')}
                            </select>
                        </div>
                        <div class="col-auto d-flex align-items-end pb-2 mx-1">to</div>
                        <div class="col">
                            <label class="form-label form-label-sm">End Time</label>
                            <select class="form-select form-select-sm end-time-select">
                                ${timeOptions.map(time => 
                                    `<option value="${time}" ${time === endTime ? 'selected' : ''}>${time}</option>`
                                ).join('')}
                            </select>
                        </div>
                    </div>
                </div>
                <div class="d-flex justify-content-between mt-2">
                    <button class="btn btn-sm btn-success save-shift-btn">Save</button>
                    ${currentShift ? '<button class="btn btn-sm btn-danger delete-shift-btn">Delete</button>' : ''}
                    <button class="btn btn-sm btn-secondary cancel-shift-btn">Cancel</button>
                </div>
            </div>
        `;
        
        // Store original content and replace with editor
        const originalContent = cell.innerHTML;
        cell.dataset.originalContent = originalContent;
        cell.innerHTML = editorHTML;
        
        // Add event listeners for checkboxes to toggle time inputs
        const offCheck = cell.querySelector('.off-check');
        const vacationCheck = cell.querySelector('.vacation-check');
        const regularShiftInputs = cell.querySelector('.regular-shift-inputs');
        
        offCheck.addEventListener('change', function() {
            if (this.checked) {
                vacationCheck.checked = false;
                regularShiftInputs.classList.add('d-none');
            } else if (!vacationCheck.checked) {
                regularShiftInputs.classList.remove('d-none');
            }
        });
        
        vacationCheck.addEventListener('change', function() {
            if (this.checked) {
                offCheck.checked = false;
                regularShiftInputs.classList.add('d-none');
            } else if (!offCheck.checked) {
                regularShiftInputs.classList.remove('d-none');
            }
        });
        
        // Add event listeners to the editor buttons
        cell.querySelector('.save-shift-btn').addEventListener('click', function() {
            let newShift = '';
            
            // Check for special statuses first
            if (offCheck.checked) {
                newShift = 'OFF';
            } else if (vacationCheck.checked) {
                newShift = 'VACATION';
            } else {
                // Regular shift time
                const startTime = cell.querySelector('.start-time-select').value;
                const endTime = cell.querySelector('.end-time-select').value;
                
                if (!startTime || !endTime) {
                    alert('Please select both start and end times or choose OFF/Vacation.');
                    return;
                }
                
                if (startTime === endTime) {
                    alert('Start time and end time cannot be the same.');
                    return;
                }
                
                // Create the new shift format
                newShift = `${startTime}-${endTime}`;
            }
            
            // Update the shift in the database
            updateEmployeeShift(employeeId, day, newShift)
                .then(() => {
                    // Reload the schedule to reflect changes
                    loadSchedule();
                })
                .catch(error => {
                    console.error('Error updating shift:', error);
                    alert('Error updating shift. Please try again.');
                    // Restore original content
                    cell.innerHTML = cell.dataset.originalContent;
                    delete cell.dataset.originalContent;
                });
        });
        
        // Delete shift button
        if (currentShift) {
            cell.querySelector('.delete-shift-btn').addEventListener('click', function() {
                if (confirm('Are you sure you want to delete this shift?')) {
                    updateEmployeeShift(employeeId, day, '')
                        .then(() => {
                            loadSchedule();
                        })
                        .catch(error => {
                            console.error('Error deleting shift:', error);
                            alert('Error deleting shift. Please try again.');
                            cell.innerHTML = cell.dataset.originalContent;
                            delete cell.dataset.originalContent;
                        });
                }
            });
        }
        
        // Cancel button
        cell.querySelector('.cancel-shift-btn').addEventListener('click', function() {
            cell.innerHTML = cell.dataset.originalContent;
            delete cell.dataset.originalContent;
            addShiftEditListeners(); // Re-add listeners to the restored content
        });
    }

    if (addEmployeeForm) {
        addEmployeeForm.addEventListener('submit', handleAddEmployeeSubmit);
    }

    if (restoreColumnsBtn) {
        restoreColumnsBtn.addEventListener('click', handleRestoreHiddenColumns);
    }
    
    // Function to update an employee's shift in the database
    function updateEmployeeShift(employeeId, day, shiftTime) {
        return fetch(`/api/employee/${employeeId}/schedule/${day}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ shift_time: shiftTime })
        })
        .then(response => {
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            return response.json();
        });
    }

    // Load departments
    function loadDepartments() {
        fetch('/api/departments')
            .then(response => response.json())
            .then(departments => {
                // Clear current options except "All Departments"
                departmentSelect.innerHTML = '<option value="">All Departments</option>';
                
        // Add department options - clean department names more thoroughly (preserve numeric prefixes like 211, 988)
                departments.forEach(department => {
                    if (department) {
                        // Clean department name: remove any time info, parentheses, numbers, etc.
                        let cleanDeptName = department;
                        
            // Remove everything after comma or parenthesis (DO NOT split on digits)
            cleanDeptName = cleanDeptName.split(/[,(]/)[0];
                        
                        // Remove things like "8a-5p" or similar time patterns
                        cleanDeptName = cleanDeptName.replace(/\b\d{1,2}[ap]-\d{1,2}[ap]\b/gi, '');
                        
                        // Remove multiple spaces and trim
                        cleanDeptName = cleanDeptName.replace(/\s+/g, ' ').trim();
                        
                        // If we still have a valid department name
                        if (cleanDeptName && cleanDeptName.length > 1) {
                            // Create option with cleaned display text but preserve original value
                            // for compatibility with existing code
                            const option = document.createElement('option');
                            option.value = department; // Keep original value for backend queries
                            option.textContent = cleanDeptName; // Show cleaned name to user
                            departmentSelect.appendChild(option);
                        }
                    }
                });
            })
            .catch(error => {
                console.error('Error loading departments:', error);
            });
    }

    // Load positions/skills
    function loadPositions() {
        fetch('/api/positions')
            .then(response => response.json())
            .then(positions => {
                console.log('Positions loaded:', positions); // Debug log
                
                // Clear current options for requiredSkill
                requiredSkillSelect.innerHTML = '<option value="">None</option>';
                
                // Clear current options for positionFilter
                positionFilter.innerHTML = '<option value="">All Positions</option>';
                
                // Add position options
                positions.forEach(position => {
                    if (position) {
                        // Create new options for each select
                        const skillOption = document.createElement('option');
                        skillOption.value = position;
                        skillOption.textContent = position;
                        
                        const filterOption = document.createElement('option');
                        filterOption.value = position;
                        filterOption.textContent = position;
                        
                        requiredSkillSelect.appendChild(skillOption);
                        positionFilter.appendChild(filterOption);
                    }
                });
            })
            .catch(error => {
                console.error('Error loading positions:', error);
            });
    }

    // Load employees
    function loadEmployees() {
        fetch('/api/employees')
            .then(response => response.json())
            .then(employees => {
                // Clear current options
                employeeSelect.innerHTML = '<option value="">Select Employee</option>';
                
                // Add employee options sorted by name, with better cleaning
                employees.sort((a, b) => {
                    const nameA = a.employee_name.split(/[,(\d]/)[0].trim(); 
                    const nameB = b.employee_name.split(/[,(\d]/)[0].trim();
                    return nameA.localeCompare(nameB);
                }).forEach(employee => {
                    // More aggressive cleaning to remove all excess whitespace
                    // First split at any comma, parenthesis, or digit and take only the first part
                    let cleanName = employee.employee_name.split(/[,(\d]/)[0];
                    // Replace multiple spaces with a single space and trim
                    cleanName = cleanName.replace(/\s+/g, ' ').trim();
                    
                    // Only add if we have a meaningful name
                    if (cleanName && cleanName.length > 1) {
                        const option = new Option(cleanName, employee.id);
                        employeeSelect.add(option);
                    }
                });
            })
            .catch(error => {
                console.error('Error loading employees:', error);
            });
    }

    // Load and display tasks
    function loadTasks() {
        fetch('/api/tasks')
            .then(response => response.json())
            .then(tasks => {
                // Store tasks globally
                assignedTasks = tasks;
                
                // Clear current tasks
                tasksTableBody.innerHTML = '';
                
                // Add rows for each task
                tasks.forEach(task => {
                    const row = document.createElement('tr');
                    row.innerHTML = `
                        <td>${task.employee_name}</td>
                        <td>${task.task_name}</td>
                        <td>${task.day_of_week}</td>
                        <td>${task.start_time} - ${task.end_time}</td>
                        <td>${task.required_skill || ''}</td>
                        <td>
                            <button class="btn btn-sm btn-danger delete-task" data-task-id="${task.id}">
                                Delete
                                    </button>
                        </td>
                    `;
                    tasksTableBody.appendChild(row);
                });

                // Add delete event listeners
                document.querySelectorAll('.delete-task').forEach(button => {
                    button.addEventListener('click', function() {
                        const taskId = this.dataset.taskId;
                        deleteTask(taskId);
                    });
                });
            })
            .catch(error => {
                console.error('Error loading tasks:', error);
        });
    }

    // Delete task
    function deleteTask(taskId) {
        if (confirm('Are you sure you want to delete this task?')) {
            fetch(`/api/tasks/${taskId}`, {
                method: 'DELETE'
            })
            .then(response => response.json())
            .then(data => {
                loadTasks(); // Refresh tasks
                loadSchedule(); // Also refresh the schedule to update task display
            })
            .catch(error => {
                console.error('Error:', error);
                alert('Error deleting task. Please try again.');
            });
        }
    }

    // Find available employees
    function findAvailableEmployees(day, startTime, endTime, position) {
        const encodedPosition = encodeURIComponent(position);
    const url = `/api/employees/available?day=${day}&start_time=${startTime}&end_time=${endTime}&position=${encodedPosition}&include_all=1`;
        
        console.log('Fetching available employees with URL:', url); // Debug log
        
        fetch(url)
            .then(response => response.json())
            .then(employees => {
                console.log('Available employees response:', employees); // Debug log
                availableEmployeesList.innerHTML = '';
                
                if (employees.length === 0) {
                    availableEmployeesList.innerHTML = '<p class="text-danger">No available employees found.</p>';
                    return;
                }
                
                const list = document.createElement('ul');
                list.className = 'list-group';
                
                                employees.forEach(employee => {
                    const item = document.createElement('li');
                    item.className = 'list-group-item';
                                        const statusBadge = employee.status === 'available' ? 'success' : (employee.status === 'off' ? 'secondary' : 'warning');
                                        const statusText = employee.status.charAt(0).toUpperCase() + employee.status.slice(1);
                                        const overlapText = employee.overlap_minutes && employee.overlap_minutes > 0 ? `<div class="small text-danger">Overlap: ${Math.round(employee.overlap_minutes/60)}h ${employee.day_shift ? `(shift ${employee.day_shift})` : ''}</div>` : '';
                                        const offText = employee.is_off ? `<div class="small text-muted">Off on ${employee.day.charAt(0).toUpperCase()+employee.day.slice(1)}</div>` : '';
                                        item.innerHTML = `
                                                <div class="d-flex justify-content-between align-items-start">
                                                    <div>
                                                        <strong>${employee.employee_name}</strong>
                                                        ${employee.position ? `<br><span class="text-muted">Position: ${employee.position}</span>` : ''}
                                                        ${employee.department ? `<br><span class="text-muted">Department: ${employee.department}</span>` : ''}
                                                        <div class="small">Requested: ${employee.requested_start}–${employee.requested_end}</div>
                                                        ${overlapText || offText}
                                                    </div>
                                                    <span class="badge bg-${statusBadge}">${statusText}</span>
                                                </div>
                                        `;
                    list.appendChild(item);
                });
                
                availableEmployeesList.appendChild(list);
        })
        .catch(error => {
            console.error('Error:', error);
                availableEmployeesList.innerHTML = '<p class="text-danger">Error finding available employees. Please try again.</p>';
    });
    }

    // Admin Login Functionality
    adminAccessBtn.addEventListener('click', function() {
        // Reset the login form
        adminPasswordInput.value = '';
        adminLoginError.style.display = 'none';
        
        // Show the login modal
        adminLoginModal.show();
    });
    
    // Handle admin login
    adminLoginBtn.addEventListener('click', function() {
        const password = adminPasswordInput.value;
        
        // Verify against server-side authentication
        fetch('/api/admin/verify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ password: password })
        })
        .then(response => response.json())
        .then(data => {
            if (data.authenticated) {
                // Login successful
                isAdminLoggedIn = true;
                adminAccessBtn.classList.add('admin-active');
                adminTickerControls.style.display = 'block';
                adminLoginModal.hide();
                
                // Update the UI to reflect admin privileges
                updateEditPermissions();
                
                // Show admin status message
                const adminAlert = document.createElement('div');
                adminAlert.className = 'alert alert-success alert-dismissible fade show admin-status-alert';
                adminAlert.innerHTML = `
                    <strong>Admin mode enabled.</strong> You can now edit the schedule.
                    <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
                `;
                document.querySelector('.container-fluid').prepend(adminAlert);
                
                // Auto-dismiss the alert after 5 seconds
                setTimeout(() => {
                    const bsAlert = new bootstrap.Alert(adminAlert);
                    bsAlert.close();
                }, 5000);
                
                // Update admin-only views
                updateAdminOnlyViews();

                reloadScheduleAfterMeta().catch(() => {
                    loadSchedule();
                });
                loadEmployees();
                loadDepartments();
                loadPositions();
                
            } else {
                // Login failed
                adminLoginError.style.display = 'block';
            }
        })
        .catch(error => {
            console.error('Error authenticating:', error);
            adminLoginError.style.display = 'block';
            adminLoginError.textContent = 'Authentication error. Please try again.';
        });
    });
    
    // Handle Enter key in password field
    adminPasswordInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            adminLoginBtn.click();
        }
    });
    
    // Add a logout function for admin
    const logoutAdmin = function() {
        isAdminLoggedIn = false;
        adminAccessBtn.classList.remove('admin-active');
        updateEditPermissions();
        
        // Show logged out message
        const adminAlert = document.createElement('div');
        adminAlert.className = 'alert alert-info alert-dismissible fade show admin-status-alert';
        adminAlert.innerHTML = `
            <strong>Admin mode disabled.</strong> The application is now in read-only mode.
            <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
        `;
        document.querySelector('.container-fluid').prepend(adminAlert);
        
        // Auto-dismiss the alert after 5 seconds
        setTimeout(() => {
            const bsAlert = new bootstrap.Alert(adminAlert);
            bsAlert.close();
        }, 5000);
        
        // Update admin-only views
        updateAdminOnlyViews();

        loadSchedule();
        loadEmployees();
        loadDepartments();
        loadPositions();
    };
    
    // Add logout button to admin button when in admin mode
    adminAccessBtn.addEventListener('dblclick', function() {
        if (isAdminLoggedIn) {
            logoutAdmin();
        }
    });
    
    // Add keyboard shortcut for admin logout (Escape key)
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && isAdminLoggedIn) {
            logoutAdmin();
        }
    });

    // Ticker Editing Functionality
    editTickerBtn.addEventListener('click', function() {
        if (!isAdminLoggedIn) return;
        
        // Populate the ticker edit form with current announcements
        renderTickerEditForm();
        
        // Show the ticker edit modal
        tickerEditModal.show();
    });
    
    // Add new ticker item
    addTickerItemBtn.addEventListener('click', function() {
        // Create a new announcement item form
        const newId = announcements.length > 0 ? Math.max(...announcements.map(a => a.id)) + 1 : 1;
        
        const tickerItem = document.createElement('div');
        tickerItem.className = 'ticker-item-form';
        tickerItem.innerHTML = `
            <div class="form-group">
                <label for="ticker-title-${newId}">Title</label>
                <input type="text" class="form-control" id="ticker-title-${newId}" placeholder="Announcement Title" required>
            </div>
            <div class="form-group">
                <label for="ticker-content-${newId}">Content</label>
                <textarea class="form-control" id="ticker-content-${newId}" rows="3" placeholder="Announcement Content" required></textarea>
            </div>
            <div class="form-group">
                <label for="ticker-type-${newId}">Type</label>
                <select class="form-select" id="ticker-type-${newId}">
                    <option value="normal">Normal</option>
                    <option value="important">Important</option>
                    <option value="urgent">Urgent</option>
                </select>
            </div>
            <div class="form-group">
                <label for="ticker-date-${newId}">Date</label>
                <input type="text" class="form-control datepicker" id="ticker-date-${newId}" placeholder="Select Date" required>
            </div>
            <div class="ticker-actions">
                <button type="button" class="btn btn-sm btn-danger remove-ticker-item" data-id="${newId}">Remove</button>
            </div>
        `;
        
        tickerItemsContainer.appendChild(tickerItem);
        
        // Initialize date picker for the new item with consistent format
        const dateInput = document.getElementById(`ticker-date-${newId}`);
        flatpickr(dateInput, {
            dateFormat: "Y-m-d", // ISO format YYYY-MM-DD for the actual value
            defaultDate: new Date(),
            altInput: true, // Use an alternative input to display the date
            altFormat: "F j, Y", // Display format (e.g., January 1, 2023)
            disableMobile: true // Prevent mobile devices from using native date picker
        });
        
        // Add event listener to remove button
        tickerItem.querySelector('.remove-ticker-item').addEventListener('click', function() {
            tickerItem.remove();
        });
    });
    
    // Save ticker changes
    saveTickerBtn.addEventListener('click', function() {
        // Gather all the ticker items from the form
        const tickerItems = tickerItemsContainer.querySelectorAll('.ticker-item-form');
        const newAnnouncements = [];
        
        tickerItems.forEach((item, index) => {
            const id = parseInt(item.querySelector('.remove-ticker-item').dataset.id);
            const title = item.querySelector('[id^="ticker-title-"]').value;
            const content = item.querySelector('[id^="ticker-content-"]').value;
            const type = item.querySelector('[id^="ticker-type-"]').value;
            const dateInput = item.querySelector('[id^="ticker-date-"]');
            
            // Skip items with missing required fields
            if (!title || !content) {
                console.log('Skipping announcement with missing title or content');
                return;
            }
            
            // Get the date directly from flatpickr's hidden input value
            // This will be in the format specified by dateFormat (Y-m-d)
            let dateValue = dateInput.value;
            
            console.log(`Raw date value for item ${id}:`, dateValue);
            
            // If we don't have a date, use today's date
            if (!dateValue) {
                dateValue = new Date().toISOString().split('T')[0];
                console.log(`Using default date for item ${id}:`, dateValue);
            }
            
            newAnnouncements.push({
                id: id,
                title: title,
                content: content,
                type: type,
                date: dateValue
            });
        });
        
        console.log('Saving announcements with dates:', newAnnouncements.map(a => a.date));
        
        // Save announcements to the server
        fetch('/api/announcements/update', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ announcements: newAnnouncements })
        })
        .then(response => response.json())
        .then(data => {
            if (data.error) {
                alert('Error saving announcements: ' + data.error);
            } else {
                announcements = data.announcements;
                renderTicker();
                tickerEditModal.hide();
                
                // Show success message
                const successAlert = document.createElement('div');
                successAlert.className = 'alert alert-success alert-dismissible fade show';
                successAlert.innerHTML = `
                    <strong>Success!</strong> Announcements have been updated.
                    <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
                `;
                document.querySelector('.container-fluid').prepend(successAlert);
                
                // Auto-dismiss after 3 seconds
                setTimeout(() => {
                    const bsAlert = new bootstrap.Alert(successAlert);
                    bsAlert.close();
                }, 3000);
            }
        })
        .catch(error => {
            console.error('Error saving announcements:', error);
            alert('Error saving announcements. Please try again.');
        });
    });
    
    // Render the ticker edit form
    function renderTickerEditForm() {
        // Clear the container first
        tickerItemsContainer.innerHTML = '';
        
        // Add each announcement to the form
        announcements.forEach(announcement => {
            const tickerItem = document.createElement('div');
            tickerItem.className = 'ticker-item-form';
            tickerItem.innerHTML = `
                <div class="form-group">
                    <label for="ticker-title-${announcement.id}">Title</label>
                    <input type="text" class="form-control" id="ticker-title-${announcement.id}" value="${announcement.title}" required>
                </div>
                <div class="form-group">
                    <label for="ticker-content-${announcement.id}">Content</label>
                    <textarea class="form-control" id="ticker-content-${announcement.id}" rows="3" required>${announcement.content}</textarea>
                </div>
                <div class="form-group">
                    <label for="ticker-type-${announcement.id}">Type</label>
                    <select class="form-select" id="ticker-type-${announcement.id}">
                        <option value="normal" ${announcement.type === 'normal' ? 'selected' : ''}>Normal</option>
                        <option value="important" ${announcement.type === 'important' ? 'selected' : ''}>Important</option>
                        <option value="urgent" ${announcement.type === 'urgent' ? 'selected' : ''}>Urgent</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="ticker-date-${announcement.id}">Date</label>
                    <input type="text" class="form-control datepicker" id="ticker-date-${announcement.id}" value="${announcement.date || ''}" required>
                </div>
                <div class="ticker-actions">
                    <button type="button" class="btn btn-sm btn-danger remove-ticker-item" data-id="${announcement.id}">Remove</button>
                </div>
            `;
            
            tickerItemsContainer.appendChild(tickerItem);
            
            // Initialize date picker with consistent format
            const dateInput = document.getElementById(`ticker-date-${announcement.id}`);
            flatpickr(dateInput, {
                dateFormat: "Y-m-d", // ISO format YYYY-MM-DD for the actual value
                defaultDate: announcement.date || new Date(),
                altInput: true, // Use an alternative input to display the date
                altFormat: "F j, Y", // Display format (e.g., January 1, 2023)
                disableMobile: true // Prevent mobile devices from using native date picker
            });
            
            // Add event listener to remove button
            tickerItem.querySelector('.remove-ticker-item').addEventListener('click', function() {
                tickerItem.remove();
            });
        });
    }
    
    // Render the ticker with current announcements
    function renderTicker() {
        // Clear the container first
        tickerContent.innerHTML = '';
        
        if (announcements.length === 0) {
            tickerContent.innerHTML = '<div class="text-muted">No announcements yet.</div>';
            return;
        }
        
        // Sort announcements by date (newest first)
        const sortedAnnouncements = [...announcements].sort((a, b) => 
            new Date(b.date) - new Date(a.date)
        );
        
        // Add each announcement to the ticker
        sortedAnnouncements.forEach(announcement => {
            const tickerItem = document.createElement('div');
            tickerItem.className = `ticker-item ${announcement.type}`;
            tickerItem.innerHTML = `
                <div class="ticker-title">${announcement.title}</div>
                <div class="ticker-body">${announcement.content}</div>
                <div class="ticker-date">${formatDate(announcement.date)}</div>
            `;
            
            tickerContent.appendChild(tickerItem);
        });
    }
    
    // Helper function to format dates nicely
    function formatDate(dateStr) {
        const date = new Date(dateStr);
        return date.toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'short', 
            day: 'numeric' 
        });
    }

    // Event Listeners for Schedule Upload
    uploadForm.addEventListener('submit', function(e) {
        e.preventDefault();
        const fileInput = document.getElementById('csvFile');
        const file = fileInput.files[0];
        if (!file) {
            alert('Please select a file');
            return;
        }

        const formData = new FormData();
        formData.append('file', file);

        fetch('/api/upload-schedule', {
            method: 'POST',
            body: formData
        })
        .then(response => response.json())
        .then(data => {
            if (data.error) {
                alert(data.error);
            } else {
                alert(data.message);
                uploadForm.reset();
                
                // Reload all data
                loadDepartments();
                loadSchedule();
                loadPositions();
                loadEmployees();
                loadTasks();
                loadAnnouncements();
            }
        })
        .catch(error => {
            console.error('Error:', error);
            alert('Error uploading file. Please try again.');
        });
    });

    // Event listener for department filter
    departmentSelect.addEventListener('change', loadSchedule);

    // Event listener for task form
    taskForm.addEventListener('submit', function(e) {
        e.preventDefault();
        
        const taskData = {
            employee_id: employeeSelect.value,
            task_name: document.getElementById('taskName').value,
            day_of_week: document.getElementById('dayOfWeek').value,
            start_time: document.getElementById('startTime').value,
            end_time: document.getElementById('endTime').value,
            required_skill: document.getElementById('requiredSkill').value
        };
        
        fetch('/api/tasks', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(taskData)
        })
        .then(response => response.json())
        .then(data => {
            if (data.error) {
                alert(data.error);
            } else {
                alert('Task added successfully!');
                taskForm.reset();
                loadTasks();
                loadSchedule(); // Also refresh the weekly schedule to show new task
            }
        })
        .catch(error => {
            console.error('Error:', error);
            alert('Error adding task. Please try again.');
    });
    });

    // Event listener for availability form
    availabilityForm.addEventListener('submit', function(e) {
        e.preventDefault();
        
        const day = document.getElementById('dayFilter').value;
        const startTime = document.getElementById('startTimeFilter').value;
        const endTime = document.getElementById('endTimeFilter').value;
        const position = document.getElementById('positionFilter').value;
        
        findAvailableEmployees(day, startTime, endTime, position);
    });

    // Add schedule date display functionality
    function setupScheduleDateDisplay() {
        try {
            renderScheduleHeaders();
        } catch (error) {
            console.error('Error updating schedule headers:', error);
        }
    }

    // Sticky header fallback: clone header into a fixed overlay on scroll
    (function setupStickyHeaderFallback(){
        const table = document.getElementById('scheduleTable');
        if (!table) return;
        let overlay = document.getElementById('scheduleStickyHeader');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'scheduleStickyHeader';
            overlay.innerHTML = '<div class="inner"><table class="table table-bordered"><thead></thead></table></div>';
            document.body.appendChild(overlay);
        }
        const overlayThead = overlay.querySelector('thead');
        const update = () => {
            const rect = table.getBoundingClientRect();
            const shouldShow = rect.top < 0 && rect.bottom > 80; // table is scrolled past top but not fully out
            overlay.style.display = shouldShow ? 'block' : 'none';
            if (!shouldShow) return;
            // mirror column widths
            const srcHeaderRows = table.querySelectorAll('thead tr');
            const srcThs = table.querySelectorAll('thead tr:first-child th');
            overlay.style.width = document.documentElement.clientWidth + 'px';
            const inner = overlay.querySelector('.inner');
            // match container width to the table container
            const wrapper = table.closest('.container-fluid') || table.parentElement;
            if (wrapper) inner.style.maxWidth = wrapper.clientWidth + 'px';
            // rebuild thead content
            overlayThead.innerHTML = '';
            srcHeaderRows.forEach((row, idx) => {
                const cloneRow = document.createElement('tr');
                row.querySelectorAll('th').forEach((th, i) => {
                    const c = th.cloneNode(true);
                    const width = th.getBoundingClientRect().width;
                    c.style.minWidth = width + 'px';
                    c.style.maxWidth = width + 'px';
                    cloneRow.appendChild(c);
                });
                overlayThead.appendChild(cloneRow);
            });
        };
        window.addEventListener('scroll', update, { passive: true });
        window.addEventListener('resize', update);
        // Also update after schedule loads
        const orig = window.loadSchedule;
        if (typeof orig === 'function') {
            window.loadSchedule = function(){ orig(); setTimeout(update, 50); };
        }
        setTimeout(update, 200);
    })();

    // Initial load
    loadDepartments();
    loadPositions();
    loadEmployees();
    loadTasks();
    loadAnnouncements(); // Load announcements from the server

    const refreshScheduleView = () => {
        loadSchedule();
        setupScheduleDateDisplay();
    };

    loadScheduleMeta()
        .then(refreshScheduleView)
        .catch(error => {
            console.error('Error loading schedule metadata:', error);
            refreshScheduleView();
        });
    
    // Update the date display every day at midnight
    const updateTimeToMidnight = () => {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        
        const timeToMidnight = tomorrow - now;
        
        setTimeout(() => {
            setupScheduleDateDisplay(); // Update dates at midnight
            updateTimeToMidnight(); // Setup next update
        }, timeToMidnight);
    };
    
    updateTimeToMidnight(); // Initialize the midnight update timer

    // Add Font Awesome for icons if not already present
    if (!document.getElementById('font-awesome-css')) {
        const fontAwesomeLink = document.createElement('link');
        fontAwesomeLink.id = 'font-awesome-css';
        fontAwesomeLink.rel = 'stylesheet';
        fontAwesomeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.3/css/all.min.css';
        document.head.appendChild(fontAwesomeLink);
    }
    
    // Handle upload toggle button
    const uploadToggle = document.getElementById('uploadToggle');
    const uploadFormContainer = document.getElementById('uploadFormContainer');
    const cancelUpload = document.getElementById('cancelUpload');
    
    if (uploadToggle && uploadFormContainer) {
        uploadToggle.addEventListener('click', function() {
            uploadFormContainer.style.display = uploadFormContainer.style.display === 'block' ? 'none' : 'block';
        });
        
        // Close when clicking cancel
        if (cancelUpload) {
            cancelUpload.addEventListener('click', function() {
                uploadFormContainer.style.display = 'none';
            });
        }
        
        // Close when clicking outside
        document.addEventListener('click', function(event) {
            if (!uploadToggle.contains(event.target) && 
                !uploadFormContainer.contains(event.target)) {
                uploadFormContainer.style.display = 'none';
            }
        });
    }
    
    // Initialize edit permissions (start in read-only mode)
    updateEditPermissions();
    
    // Update title to indicate the app is in read-only mode initially
    const title = document.querySelector('title');
    title.textContent = 'ShiftLine Schedule (Read-Only)';

    // Time-off request handling
    document.getElementById('timeoffForm').addEventListener('submit', function(e) {
        e.preventDefault();
        const data = {
            employee_id: document.getElementById('timeoffEmployeeSelect').value,
            request_type: document.getElementById('timeoffType').value,
            start_date: document.getElementById('timeoffStart').value,
            end_date: document.getElementById('timeoffEnd').value,
            reason: document.getElementById('timeoffReason').value
        };
        fetch('/api/timeoff', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }).then(() => {
            loadTimeOffRequests();
            this.reset();
        });
    });

    function loadTimeOffRequests() {
        fetch('/api/timeoff')
            .then(res => res.json())
            .then(requests => {
                const container = document.getElementById('timeoffRequestList');
                container.innerHTML = '';
                requests.forEach(r => {
                    const li = document.createElement('li');
                    li.className = 'list-group-item';
                    li.innerHTML = `
                        <strong>${r.employee_name}</strong> (${r.request_type.toUpperCase()}): 
                        ${r.start_date} to ${r.end_date}<br>
                        <em>${r.reason}</em><br>
                        <span class="badge bg-${r.status === 'approved' ? 'success' : r.status === 'denied' ? 'danger' : 'secondary'}">${r.status}</span>
                    `;
                    // manager actions
                    if (isAdminLoggedIn && r.status === 'pending') {
                        const approveBtn = document.createElement('button');
                        approveBtn.className = 'btn btn-sm btn-success me-2';
                        approveBtn.textContent = 'Approve';
                        approveBtn.onclick = () => updateTimeoffStatus(r.id, 'approved');
                        const denyBtn = document.createElement('button');
                        denyBtn.className = 'btn btn-sm btn-danger';
                        denyBtn.textContent = 'Deny';
                        denyBtn.onclick = () => updateTimeoffStatus(r.id, 'denied');
                        li.appendChild(approveBtn);
                        li.appendChild(denyBtn);
                    }
                    // conflict check display
                    fetch(`/api/timeoff/conflicts?employee_id=${r.employee_id}&start_date=${r.start_date}&end_date=${r.end_date}`)
                        .then(res=>res.json())
                        .then(c => {
                          if (c.conflicts && c.conflicts.length) {
                            const warn = document.createElement('div');
                            warn.className = 'mt-2';
                            warn.innerHTML = `<span class="badge bg-warning text-dark">Conflicts: ${c.conflicts.length}</span>`;
                            li.appendChild(warn);
                          }
                        })
                        .catch(()=>{});
                    container.appendChild(li);
                });
            });
    }

    function updateTimeoffStatus(id, status) {
        fetch(`/api/timeoff/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        }).then(() => loadTimeOffRequests());
    }

    // Populate employee dropdown for requests
    fetch('/api/employees')
        .then(res => res.json())
        .then(data => {
            const select = document.getElementById('timeoffEmployeeSelect');
            data.forEach(emp => {
                const opt = document.createElement('option');
                opt.value = emp.id;
                opt.textContent = emp.employee_name;
                select.appendChild(opt);
            });
        });

    // Load requests on tab switch
    document.getElementById('timeoff-tab').addEventListener('click', loadTimeOffRequests);

    // Predictive Insights Functionality
    function loadPredictiveInsights() {
        fetch('/api/predictive-insights')
            .then(res => res.json())
            .then(data => {
                const list = document.getElementById('insightsList');
                list.innerHTML = '';
                data.forEach(emp => {
                    const item = document.createElement('li');
                    item.className = 'list-group-item';
                    item.innerHTML = `
                        <strong>${emp.employee_name}</strong><br>
                        Sick Days: ${emp.sick_days}, PTO: ${emp.pto_days}, Vacation: ${emp.vacation_days}<br>
                        Workdays This Week: ${emp.workdays_this_week}<br>
                        <span class="badge bg-${emp.burnout_risk ? 'danger' : 'success'}">
                            ${emp.burnout_risk ? 'Burnout Risk' : 'Healthy'}
                        </span>
                        <br><em>${emp.recommendation}</em>
                    `;
                    list.appendChild(item);
                });
            });
    }

    document.getElementById('insights-tab').addEventListener('click', loadPredictiveInsights);

    // Load initial data for insights
    loadPredictiveInsights();

    // --- Time Off: conflict check on submit ---
    const timeoffFormEl = document.getElementById('timeoffForm');
    if (timeoffFormEl) {
      timeoffFormEl.addEventListener('submit', function(e) {
        e.preventDefault();
        const empId = document.getElementById('timeoffEmployeeSelect').value;
        const start = document.getElementById('timeoffStart').value;
        const end = document.getElementById('timeoffEnd').value;

        fetch(`/api/timeoff/conflicts?employee_id=${empId}&start_date=${start}&end_date=${end}`)
          .then(r => r.json())
          .then(result => {
            if (result.conflicts && result.conflicts.length > 0) {
              const proceed = confirm(`Conflicts detected on ${result.conflicts.length} day(s). Submit anyway?`);
              if (!proceed) return;
            }
            // proceed with original submit
            const data = {
              employee_id: empId,
              request_type: document.getElementById('timeoffType').value,
              start_date: start,
              end_date: end,
              reason: document.getElementById('timeoffReason').value
            };
            fetch('/api/timeoff', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
            }).then(() => { loadTimeOffRequests(); timeoffFormEl.reset(); });
          });
      });
    }

    // --- Schedule overlay: show approved time off as OFF ---
    function loadApprovedTimeOffMap() {
      return fetch('/api/timeoff')
        .then(res => res.json())
        .then(items => {
          const map = {}; // { employeeId: Set([isoDates...]) }
          items.filter(i => i.status === 'approved').forEach(i => {
            const s = new Date(i.start_date);
            const e = new Date(i.end_date);
            for (let d = new Date(s); d <= e; d.setDate(d.getDate()+1)) {
              const key = i.employee_id;
              if (!map[key]) map[key] = new Set();
              map[key].add(d.toISOString().slice(0,10));
            }
          });
          return map;
        });
    }

    // Patch into loadSchedule rendering to annotate cells
    const originalLoadSchedule = typeof loadSchedule === 'function' ? loadSchedule : null;
    if (originalLoadSchedule) {
      window.loadSchedule = function() {
        Promise.all([
          fetch('/api/timeoff').then(r=>r.json()),
        ]).then(([allTimeoff]) => {
          // Build helper for week date mapping
          const today = new Date();
          const dow = today.getDay();
          const daysToGoBack = dow === 6 ? 0 : dow + 1; // aligns with existing logic
          const start = new Date(today); start.setDate(today.getDate()-daysToGoBack);
          const dayKeys = ['saturday','sunday','monday','tuesday','wednesday','thursday','friday'];
          const dayDates = {}; // {daykey: 'YYYY-MM-DD'}
          for (let i=0;i<7;i++){ const d=new Date(start); d.setDate(start.getDate()+i); dayDates[dayKeys[i]]=d.toISOString().slice(0,10); }

          // Approved map for quick lookup
          const approved = {};
          allTimeoff.filter(i=>i.status==='approved').forEach(i=>{
            const s=new Date(i.start_date), e=new Date(i.end_date);
            for(let d=new Date(s); d<=e; d.setDate(d.getDate()+1)){
              const iso = d.toISOString().slice(0,10);
              if(!approved[i.employee_id]) approved[i.employee_id]={};
              approved[i.employee_id][iso]=true;
            }
          });

          // Temporarily hook DOM insertion by observing after rows render
          const tbody = document.getElementById('scheduleTableBody');
          const observer = new MutationObserver(() => {
            // annotate cells
            tbody.querySelectorAll('td.schedule-cell').forEach(td => {
              const empId = td.getAttribute('data-employee-id');
              const day = td.getAttribute('data-day');
              const dateISO = dayDates[day];
              if (empId && dateISO && approved[empId] && approved[empId][dateISO]) {
                const content = td.querySelector('.shift-content');
                if (content && !content.dataset.timeoffApplied) {
                  const current = content.innerHTML.trim();
                  const label = '<span class="badge bg-info ms-1">TIME OFF</span>';
                  content.innerHTML = current ? current + '<br>' + label : label;
                  content.dataset.timeoffApplied = '1';
                }
              }
            });
            observer.disconnect();
          });
          observer.observe(tbody, { childList: true, subtree: true });

          // call original renderer
          originalLoadSchedule();
        });
      }
    }

    // Admin-only views helper
function updateAdminOnlyViews() {
    const insightsTabBtn = document.getElementById('insights-tab');
    const insightsPane = document.getElementById('insights-tab-pane');
    if (insightsTabBtn) insightsTabBtn.style.display = isAdminLoggedIn ? '' : 'none';
    if (insightsPane) insightsPane.style.display = isAdminLoggedIn ? '' : 'none';
}

// Run once on load to hide admin-only panels
updateAdminOnlyViews();

// Enhance admin login success path to expose AI Insights
// ...existing code...
// After admin login sets isAdminLoggedIn = true, also call:
// updateAdminOnlyViews();

// Helper to get today's weekday key matching backend (sunday..saturday)
function getTodayKey() {
    const map = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    return map[new Date().getDay()];
}

// Extend Predictive Insights to include break allowance and 988 coverage snapshot
(function(){
  const origLoadInsights = typeof loadPredictiveInsights === 'function' ? loadPredictiveInsights : null;
  if (!origLoadInsights) return;
  window.loadPredictiveInsights = function() {
    if (!isAdminLoggedIn) return;
        Promise.all([
            fetch('/api/predictive-insights').then(r=>r.json()),
      fetch('/api/coverage/988').then(r=>r.json()).catch(()=>null),
      fetch('/api/coverage/988/detailed').then(r=>r.json()).catch(()=>null)
    ]).then(([data, cov, detailed]) => {
            const list = document.getElementById('insightsList');
      if (!list) return;
      list.innerHTML = '';
            const resp = data || {};
            const employees = Array.isArray(resp) ? resp : (resp.employees || []);
            const coverageSug = Array.isArray(resp) ? [] : (resp.coverage_suggestions || []);

      // Action Center containers
      const covUl = document.getElementById('coverageIssues');
      const burnUl = document.getElementById('burnoutRisks');
      if (covUl) covUl.innerHTML = '';
      if (burnUl) burnUl.innerHTML = '';

      // 988 coverage snapshot row
      if (cov && list) {
        const covItem = document.createElement('li');
        covItem.className = 'list-group-item';
        const days = ['saturday','sunday','monday','tuesday','wednesday','thursday','friday'];
        const rows = days.map(d => `${d.charAt(0).toUpperCase()+d.slice(1)}: ${cov.counts[d]} (min 2${cov.prefer3 && cov.prefer3[d] ? ', prefer 3' : ''})`).join('<br>');
        covItem.innerHTML = `<strong>988/CRISIS Coverage (week):</strong><br>${rows}`;
        list.appendChild(covItem);
      }

      // Coverage Action Center from detailed
      if (detailed && covUl) {
        const dayNames = ['Saturday','Sunday','Monday','Tuesday','Wednesday','Thursday','Friday'];
        const dayKeys = ['saturday','sunday','monday','tuesday','wednesday','thursday','friday'];
        let anyIssue = false;
        dayKeys.forEach((dk, i) => {
          const issues = detailed[dk] || [];
          issues.forEach(issue => {
            anyIssue = true;
            const li = document.createElement('li');
            li.className = 'list-group-item d-flex justify-content-between align-items-start';
            const sevBadge = issue.severity === 'critical' ? 'danger' : 'warning';
            const suggestions = (issue.suggested_backfill||[]).map(s=>s.name).join(', ') || '—';
            li.innerHTML = `
              <div>
                <span class="badge bg-${sevBadge} me-2 text-uppercase">${issue.severity}</span>
                <strong>${dayNames[i]}</strong> ${issue.from}–${issue.to}
                <div class="small text-muted">Need ≥ ${issue.needed}. Suggested: ${suggestions}</div>
              </div>
            `;
            covUl.appendChild(li);
          });
        });
        if (!anyIssue) {
          const li = document.createElement('li');
          li.className = 'list-group-item text-success';
          li.textContent = 'No coverage issues detected this week.';
          covUl.appendChild(li);
        }
      }

      // Employees list with richer metrics
      const todayKey = getTodayKey();
    employees.forEach(emp => {
        const item = document.createElement('li');
        item.className = 'list-group-item';
      const ptoOverlap = emp.pto_overlap_dates && emp.pto_overlap_dates.length ? emp.pto_overlap_dates.join(', ') : 'None';
      const drivers = (emp.drivers && emp.drivers.length) ? ('Drivers: ' + emp.drivers.join(', ')) : '';
      const riskBadge = emp.risk_level === 'high' ? 'danger' : (emp.risk_level === 'medium' ? 'warning' : 'success');
        item.innerHTML = `
          <div class="d-flex w-100 justify-content-between">
            <div>
              <strong>${emp.employee_name}</strong> ${emp.department ? `(<span class="text-muted">${emp.department}</span>)` : ''}<br>
          <span class="badge bg-${riskBadge}">${emp.risk_level ? emp.risk_level.toUpperCase() : (emp.burnout_risk ? 'RISK' : 'HEALTHY')}</span>
          <span class="ms-2 text-muted">Risk Score: ${emp.risk_score ?? (emp.burnout_risk ? 60 : 10)}</span><br>
          ${emp.narrative ? `<div>${emp.narrative}</div>` : ''}
          <div class="small text-muted">Workdays: ${emp.workdays_this_week} • Weekly: ${emp.weekly_hours}h • Weekend: ${emp.weekend_hours}h • Nights: ${emp.night_shifts} • Rest violations: ${emp.rest_violations} • Heavy streak: ${emp.max_heavy_streak} • PTO overlap: ${ptoOverlap}</div>
          ${drivers ? `<div class="small">${drivers}</div>` : ''}
          <div class="mt-1" data-break="loading">Calculating break allowance...</div>
            </div>
          </div>
        `;
        list.appendChild(item);
        fetch(`/api/break-allowance?employee_id=${emp.employee_id}&day=${todayKey}`)
          .then(r => r.json())
          .then(br => {
            const target = item.querySelector('[data-break]');
            if (target) target.textContent = `Break allowance today: ${br.minutes || 0} minutes`;
          }).catch(()=>{});

        // Burnout action center
                if (burnUl && (emp.burnout_risk || (emp.risk_level && emp.risk_level !== 'low'))) {
          const r = document.createElement('li');
          r.className = 'list-group-item';
          r.innerHTML = `
                        <strong>${emp.employee_name}</strong>: ${emp.narrative || ''}
                        <div class="small text-muted">Drivers: ${emp.drivers ? emp.drivers.join(', ') : '—'}</div>
          `;
          burnUl.appendChild(r);
        }
      });
            // Coverage backfill suggestions preview
            if (coverageSug && coverageSug.length) {
                const header = document.createElement('li');
                header.className = 'list-group-item active';
                header.textContent = 'Potential Coverage Backfills (988/CRISIS)';
                list.appendChild(header);
                coverageSug.forEach(sug => {
                    const li = document.createElement('li');
                    li.className = 'list-group-item';
                    const names = (sug.suggested_backfill||[]).map(x=>x.name).join(', ') || 'No available matches';
                    const sevBadge = sug.severity === 'critical' ? 'danger' : 'warning';
                    li.innerHTML = `
                        <span class="badge bg-${sevBadge} me-2">${sug.severity.toUpperCase()}</span>
                        <strong>${sug.day_key.charAt(0).toUpperCase()+sug.day_key.slice(1)}</strong> ${sug.from}–${sug.to}
                        <div class="small text-muted">Need ≥ ${sug.needed}, current ${sug.current}. Suggested: ${names}</div>
                    `;
                    list.appendChild(li);
                });
            }
    });
  }
})();

// Only auto-load insights if admin is already logged in
if (isAdminLoggedIn) {
  loadPredictiveInsights();
}

// Suggestions UI Functionality
(function(){
    function renderSuggestions(items) {
        const ul = document.getElementById('suggestionsList');
        if (!ul) return;
        ul.innerHTML = '';
        if (!items || !items.length) {
            const li = document.createElement('li');
            li.className = 'list-group-item text-muted';
            li.textContent = 'No suggestions.';
            ul.appendChild(li);
            return;
        }
        items.forEach(s => {
            const li = document.createElement('li');
            li.className = 'list-group-item d-flex justify-content-between align-items-start';
            const left = document.createElement('div');
            const when = (s.day_key && s.start_time) ? `${s.day_key.charAt(0).toUpperCase() + s.day_key.slice(1)} ${s.start_time}-${s.end_time}` : '';
            left.innerHTML = `<strong>[${s.type}] ${s.title}</strong><br>` +
                `<span class="text-muted small">${when}${s.employee_name ? ' • ' + s.employee_name : ''}</span>` +
                `<div class="small">${s.description || ''}</div>`;
            const right = document.createElement('div');
            if (isAdminLoggedIn) {
                const approve = document.createElement('button');
                approve.className = 'btn btn-sm btn-success me-2';
                approve.textContent = 'Approve';
                approve.onclick = () => updateSuggestion(s.id, 'approved');
                const deny = document.createElement('button');
                deny.className = 'btn btn-sm btn-outline-danger';
                deny.textContent = 'Deny';
                deny.onclick = () => updateSuggestion(s.id, 'denied');
                right.appendChild(approve);
                right.appendChild(deny);
            }
            li.appendChild(left);
            li.appendChild(right);
            ul.appendChild(li);
        });
    }

    function loadSuggestions() {
        fetch('/api/suggestions?status=pending')
            .then(r => r.json())
            .then(renderSuggestions);
    }

    function updateSuggestion(id, status) {
        fetch(`/api/suggestions/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        }).then(r => r.json())
            .then(() => loadSuggestions());
    }

    const genBtn = document.getElementById('btnGenSuggestions');
    if (genBtn) {
        genBtn.addEventListener('click', () => {
            if (!isAdminLoggedIn) return;
            fetch('/api/suggestions/generate?scope=all', { method: 'POST' })
                .then(() => loadSuggestions());
        });
    }

    const emailBtn = document.getElementById('btnEmailInsights');
    if (emailBtn) {
        emailBtn.addEventListener('click', () => {
            if (!isAdminLoggedIn) return;
            fetch('/api/email/insights', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ recipients: '' })
            })
                .then(r => r.json())
                .then(x => {
                    const msg = document.createElement('div');
                    msg.className = 'alert alert-info mt-2';
                    msg.textContent = `Summary emailed to: ${x.sent_to.join(', ')}`;
                    emailBtn.parentElement.after(msg);
                    setTimeout(() => msg.remove(), 4000);
                });
        });
    }

    const insightsTabBtn = document.getElementById('insights-tab');
    if (insightsTabBtn) {
        insightsTabBtn.addEventListener('click', () => {
            if (isAdminLoggedIn) loadSuggestions();
        });
    }
})();

    });

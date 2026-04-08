from flask import Flask, render_template, request, redirect, url_for, session, jsonify, flash
from werkzeug.security import generate_password_hash, check_password_hash
from flask_socketio import SocketIO, emit, join_room, leave_room
from models import db, User, Request, Session, Feedback
import os

app = Flask(__name__)
app.config['TEMPLATES_AUTO_RELOAD'] = True
app.config['SECRET_KEY'] = 'super-secret-key-123'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///database.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db.init_app(app)
socketio = SocketIO(app, cors_allowed_origins="*")

with app.app_context():
    db.create_all()

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        email = request.form.get('email')
        password = request.form.get('password')
        otp = request.form.get('otp')

        user = User.query.filter_by(email=email).first()
        if user and check_password_hash(user.password_hash, password):
            if user.is_banned:
                flash("Your account has been banned due to repeated reports or negative feedback.", "error")
                return redirect(url_for('login'))
            if otp == '1234': # Simulated OTP
                session['user_id'] = user.id
                session['role'] = user.role
                return redirect(url_for('dashboard'))
            else:
                flash("Invalid OTP", "error")
        else:
            flash("Invalid email or password", "error")
            
    return render_template('auth.html', mode='login')

@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        name = request.form.get('name')
        email = request.form.get('email')
        password = request.form.get('password')
        role = request.form.get('role')
        otp = request.form.get('otp')

        if User.query.filter_by(email=email).first():
            flash('Email already registered', 'error')
            return redirect(url_for('register'))
            
        if otp == '1234':
            hashed_password = generate_password_hash(password)
            new_user = User(name=name, email=email, password_hash=hashed_password, role=role)
            db.session.add(new_user)
            db.session.commit()
            flash('Registration successful! Please login.', 'success')
            return redirect(url_for('login'))
        else:
            flash("Invalid OTP", "error")

    return render_template('auth.html', mode='register')

@app.route('/dashboard')
def dashboard():
    if 'user_id' not in session:
        return redirect(url_for('login'))
        
    user = User.query.get(session['user_id'])
    
    if user.role == 'seeker':
        requests = Request.query.filter_by(seeker_id=user.id).all()
        for r in requests:
            if r.status == 'Accepted':
                sess_obj = Session.query.filter_by(request_id=r.id, status='Active').first()
                if sess_obj:
                    r.session_id = sess_obj.id
        return render_template('dashboard.html', user=user, requests=requests)
    else:
        pending_requests = Request.query.filter_by(status='Pending').all()
        expert_requests = Request.query.filter_by(expert_id=user.id).all()
        request_ids = [req.id for req in expert_requests]
        active_sessions = []
        if request_ids:
            active_sessions = Session.query.filter(Session.request_id.in_(request_ids), Session.status=='Active').all()
            for sess_obj in active_sessions:
                r = Request.query.get(sess_obj.request_id)
                sess_obj.request_title = r.title if r else "Request"
        return render_template('dashboard.html', user=user, pending_requests=pending_requests, active_sessions=active_sessions)

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('index'))

@app.route('/api/request/post', methods=['POST'])
def post_request():
    if 'user_id' not in session: return jsonify({'error': 'Unauthorized'}), 401
    data = request.json
    new_req = Request(
        seeker_id=session['user_id'],
        title=data['title'],
        description=data['description'],
        category=data['category']
    )
    db.session.add(new_req)
    db.session.commit()
    
    # Notify experts via SocketIO
    socketio.emit('new_request', {
        'id': new_req.id,
        'title': new_req.title,
        'category': new_req.category,
        'seeker_id': new_req.seeker_id
    })
    
    return jsonify({'success': True, 'request_id': new_req.id})

@app.route('/api/request/accept/<int:req_id>', methods=['POST'])
def accept_request(req_id):
    if 'user_id' not in session or session.get('role') != 'expert':
        return jsonify({'error': 'Unauthorized'}), 401
        
    req = Request.query.get(req_id)
    if req and req.status == 'Pending':
        req.status = 'Accepted'
        req.expert_id = session['user_id']
        
        # Create a new session
        new_session = Session(request_id=req.id)
        db.session.add(new_session)
        db.session.commit()
        
        # Notify the seeker
        socketio.emit('request_accepted', {
            'request_id': req.id,
            'session_id': new_session.id,
            'expert_id': req.expert_id
        }, to=str(req.seeker_id))
        
        return jsonify({'success': True, 'session_id': new_session.id})
    return jsonify({'success': False, 'error': 'Request not found or already accepted'})

@app.route('/api/request/auto_answer/<int:req_id>')
def auto_answer(req_id):
    req = Request.query.get(req_id)
    if not req or req.status != 'Pending':
        return jsonify({'error': 'Invalid request'}), 400
        
    req.status = 'AutoAnswered'
    db.session.commit()
    
    # Simple robust Google lookup link generator replacing failed scraping
    import urllib.parse
    query = urllib.parse.quote(req.title)
    
    results = [
        {
            'title': f"Google Search: {req.title}", 
            'link': f"https://www.google.com/search?q={query}", 
            'snippet': "Click here to view live Google Search results to solve your issue."
        },
        {
            'title': f"StackOverflow Results", 
            'link': f"https://stackoverflow.com/search?q={query}", 
            'snippet': "See community answers and verified solutions on StackOverflow."
        }
    ]
        
    youtube_suggestions = [
        {'title': f"{req.title} - Full Tutorial", 'link': f"https://www.youtube.com/results?search_query={query}", 'thumbnail': 'https://via.placeholder.com/120x90.png?text=YT+Tutorial'},
        {'title': f"How to fix {req.category} issues fast", 'link': f"https://www.youtube.com/results?search_query={query}+fix", 'thumbnail': 'https://via.placeholder.com/120x90.png?text=Tips'}
    ]
    
    return jsonify({
        'success': True,
        'google_results': results,
        'youtube_suggestions': youtube_suggestions
    })

@app.route('/session/<int:session_id>')
def session_view(session_id):
    return render_template('session.html', session_id=session_id)

@app.route('/activity_logs')
def activity_logs():
    if 'user_id' not in session: return redirect(url_for('login'))
    user = User.query.get(session['user_id'])
    
    # Simple query for their related requests
    if user.role == 'seeker':
        logs = Request.query.filter_by(seeker_id=user.id).all()
    else:
        logs = Request.query.filter_by(expert_id=user.id).all()
        
    return render_template('activity_logs.html', user=user, logs=logs)

@app.route('/help_center')
def help_center():
    if 'user_id' not in session: return redirect(url_for('login'))
    user = User.query.get(session['user_id'])
    return render_template('help_center.html', user=user)

@app.route('/profile', methods=['GET', 'POST'])
def profile():
    if 'user_id' not in session: return redirect(url_for('login'))
    user = User.query.get(session['user_id'])
    
    if request.method == 'POST':
        user.name = request.form.get('name')
        user.skills = request.form.get('skills')
        user.description = request.form.get('description')
        
        if 'profile_image' in request.files:
            file = request.files['profile_image']
            if file and file.filename != '':
                from werkzeug.utils import secure_filename
                filename = secure_filename(file.filename)
                upload_folder = os.path.join(app.static_folder, 'uploads')
                if not os.path.exists(upload_folder):
                    os.makedirs(upload_folder)
                file.save(os.path.join(upload_folder, filename))
                user.profile_image = filename
                
        db.session.commit()
        flash('Profile updated successfully!', 'success')
        return redirect(url_for('profile'))
        
    return render_template('profile.html', user=user)

@app.route('/feedback/<int:session_id>', methods=['GET', 'POST'])
def feedback(session_id):
    if 'user_id' not in session: return redirect(url_for('login'))
    if request.method == 'POST':
        rating = int(request.form.get('rating', 5))
        satisfied = request.form.get('satisfied') == 'yes'
        comment = request.form.get('comment')
        
        fb = Feedback(session_id=session_id, rating=rating, satisfied=satisfied, comment=comment)
        db.session.add(fb)
        
        # Check ban logic for not satisfied
        sess = Session.query.get(session_id)
        if sess and not satisfied:
            r_obj = Request.query.get(sess.request_id)
            if r_obj and r_obj.expert_id:
                expert = User.query.get(r_obj.expert_id)
                not_sat_count = Feedback.query.join(Session).join(Request).filter(
                    Request.expert_id == expert.id,
                    Feedback.satisfied == False
                ).count()
                if not_sat_count >= 10:
                    expert.is_banned = True
                    
        db.session.commit()
        return redirect(url_for('dashboard'))
        
    return render_template('feedback.html', session_id=session_id)

@app.route('/report/<int:session_id>', methods=['POST'])
def report_session(session_id):
    if 'user_id' not in session: return redirect(url_for('login'))
    reason = request.form.get('report_reason')
    
    proof_file = None
    if 'proof' in request.files:
        p_file = request.files['proof']
        if p_file.filename != '':
            proof_file = p_file.filename
            if not os.path.exists('uploads'):
                os.makedirs('uploads')
            p_file.save(os.path.join('uploads', proof_file))
            
    fb = Feedback(session_id=session_id, rating=1, satisfied=False, reported=True, report_reason=reason, proof_file=proof_file)
    db.session.add(fb)
    
    # Check ban logic for reported (>= 3 with proof)
    sess = Session.query.get(session_id)
    if sess:
        r_obj = Request.query.get(sess.request_id)
        if r_obj and r_obj.expert_id:
            expert = User.query.get(r_obj.expert_id)
            report_count = Feedback.query.join(Session).join(Request).filter(
                Request.expert_id == expert.id,
                Feedback.reported == True,
                Feedback.proof_file != None
            ).count()
            if report_count >= 3:
                expert.is_banned = True

    db.session.commit()
    flash('Report submitted. Our team will review this session.', 'error')
    return redirect(url_for('dashboard'))

# --- SocketIO Events --- #
@socketio.on('connect')
def handle_connect():
    print(f"Client connected: {request.sid}")

@socketio.on('join')
def handle_join(data):
    user_id = data.get('user_id')
    if user_id:
        join_room(str(user_id))
        print(f"User {user_id} joined room.")

@socketio.on('join_session')
def handle_join_session(data):
    session_id = data.get('session_id')
    if session_id:
        join_room(f"session_{session_id}")

@socketio.on('ready')
def handle_ready(data):
    emit('ready', data, to=f"session_{data['session_id']}")

@socketio.on('offer')
def handle_offer(data):
    emit('offer', data, to=f"session_{data['session_id']}")

@socketio.on('answer')
def handle_answer(data):
    emit('answer', data, to=f"session_{data['session_id']}")

@socketio.on('ice-candidate')
def handle_ice(data):
    emit('ice-candidate', data, to=f"session_{data['session_id']}")

@socketio.on('chat_message')
def handle_chat(data):
    emit('chat_message', data, to=f"session_{data['session_id']}")

@socketio.on('location_update')
def handle_location(data):
    emit('location_update', data, to=f"session_{data['session_id']}")

@socketio.on('end_session')
def handle_end_session(data):
    sess = Session.query.get(data['session_id'])
    if sess:
        sess.status = 'Ended'
        req = Request.query.get(sess.request_id)
        if req: req.status = 'Completed'
        db.session.commit()
    emit('session_ended', data, to=f"session_{data['session_id']}")

@socketio.on('disconnect')
def handle_disconnect():
    print(f"Client disconnected: {request.sid}")

if __name__ == '__main__':
    socketio.run(app, debug=True, host='127.0.0.1', port=5000)

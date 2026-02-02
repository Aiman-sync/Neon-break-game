
    (function () {
      'use strict';

      // Canvas setup
      const canvas = document.getElementById('canvas');
      const ctx = canvas.getContext('2d');

      // Crisp pixel look
      ctx.imageSmoothingEnabled = false;

      // HUD elements
      const elLives = document.getElementById('lives');
      const elScore = document.getElementById('score');
      const elLevel = document.getElementById('level');
      const btnStart = document.getElementById('btnStart');
      const btnPause = document.getElementById('btnPause');
      const btnReset = document.getElementById('btnReset');

      // Game constants
      const WIDTH = canvas.width;
      const HEIGHT = canvas.height;
      const PADDLE_Y = HEIGHT - 36;
      const PADDLE_BASE_WIDTH = 120;
      const PADDLE_HEIGHT = 16;
      const BALL_RADIUS = 6;
      const BRICK_ROWS = 6;
      const BRICK_COLS = 10;
      const BRICK_W = Math.floor((WIDTH - 80) / BRICK_COLS);
      const BRICK_H = 22;
      const POWER_CHANCE = 0.18; // chance a destroyed brick drops a power-up

      // Game states
      const STATE = { READY: 'READY', PLAYING: 'PLAYING', PAUSED: 'PAUSED', LEVEL_COMPLETE: 'LEVEL_COMPLETE', GAME_OVER: 'GAME_OVER' };

      /* -------------------------
         Utility helpers
         ------------------------- */
      function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
      function randChoice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
      function now() { return performance.now(); }

      /* -------------------------
         Input Manager (keyboard + touch)
         ------------------------- */
      class Input {
        constructor(canvas) {
          this.left = false;
          this.right = false;
          this.launch = false;
          this.pointerDown = false;
          this.pointerX = 0;
          this.canvas = canvas;
          this._bind();
        }
        _bind() {
          window.addEventListener('keydown', (e) => {
            if (e.code === 'ArrowLeft' || e.code === 'KeyA') this.left = true;
            if (e.code === 'ArrowRight' || e.code === 'KeyD') this.right = true;
            if (e.code === 'Space') this.launch = true;
          });
          window.addEventListener('keyup', (e) => {
            if (e.code === 'ArrowLeft' || e.code === 'KeyA') this.left = false;
            if (e.code === 'ArrowRight' || e.code === 'KeyD') this.right = false;
            if (e.code === 'Space') this.launch = false;
          });

          // Pointer events for paddle drag & tap to launch
          this.canvas.addEventListener('pointerdown', (e) => {
            this.pointerDown = true;
            const rect = this.canvas.getBoundingClientRect();
            this.pointerX = (e.clientX - rect.left) * (this.canvas.width / rect.width);
            // immediate launch on tap if state READY
            this.launch = true;
          });
          window.addEventListener('pointerup', () => {
            this.pointerDown = false;
            this.launch = false;
          });
          window.addEventListener('pointermove', (e) => {
            if (!this.pointerDown) return;
            const rect = this.canvas.getBoundingClientRect();
            this.pointerX = (e.clientX - rect.left) * (this.canvas.width / rect.width);
          });
        }
      }

      /* -------------------------
         Sound (small WebAudio SFX & simple music)
         ------------------------- */
      class Sound {
        constructor() {
          try {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
          } catch (e) {
            this.ctx = null;
          }
          this.masterGain = this.ctx ? this.ctx.createGain() : null;
          if (this.masterGain) {
            this.masterGain.gain.value = 0.12;
            this.masterGain.connect(this.ctx.destination);
          }
        }

        _playOsc(freq, type, time, duration = 0.08, gain = 0.12) {
          if (!this.ctx) return;
          const o = this.ctx.createOscillator();
          o.type = type;
          o.frequency.value = freq;
          const g = this.ctx.createGain();
          g.gain.value = gain;
          o.connect(g);
          g.connect(this.masterGain);
          const t0 = this.ctx.currentTime + time;
          g.gain.setValueAtTime(gain, t0);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
          o.start(t0);
          o.stop(t0 + duration + 0.02);
        }

        hit() { this._playOsc(860, 'sawtooth', 0, 0.06, 0.08); }
        break() { this._playOsc(420, 'triangle', 0, 0.12, 0.12); }
        power() { this._playOsc(1200, 'square', 0, 0.12, 0.12); }

        // simple background loop using scheduled notes (non-musical but chiptune-like)
        startMusic() {
          if (!this.ctx) return;
          if (this._musicId) return;
          const ctx = this.ctx;
          const master = this.masterGain;
          let i = 0;
          const pattern = [440, 660, 880, 660];
          const playNote = () => {
            const freq = pattern[i % pattern.length] * (i % 2 === 0 ? 1 : 0.5);
            const o = ctx.createOscillator();
            o.type = 'triangle';
            o.frequency.value = freq;
            const g = ctx.createGain();
            g.gain.value = 0.01;
            o.connect(g); g.connect(master);
            const nowt = ctx.currentTime;
            g.gain.linearRampToValueAtTime(0.01, nowt + 0.01);
            g.gain.linearRampToValueAtTime(0.004, nowt + 0.22);
            o.start(nowt);
            o.stop(nowt + 0.25);
            i++;
            this._musicId = setTimeout(playNote, 250);
          };
          playNote();
        }
        stopMusic() {
          if (this._musicId) {
            clearTimeout(this._musicId);
            this._musicId = null;
          }
        }
      }

      /* -------------------------
         Game Objects
         ------------------------- */

      // Paddle: controlled by player; has width, x, y; can expand with power-up
      class Paddle {
        constructor() {
          this.width = PADDLE_BASE_WIDTH;
          this.height = PADDLE_HEIGHT;
          this.x = WIDTH / 2 - this.width / 2;
          this.y = PADDLE_Y;
          this.speed = 960; // px/s movement speed when keyboard controlled
          this.expireTimer = 0; // timer for larger paddle power-up
          this.color = '#ffffff';
        }

        update(dt, input) {
          // keyboard movement
          let move = 0;
          if (input.left) move -= 1;
          if (input.right) move += 1;

          // pointer drag movement overrides keyboard
          if (input.pointerDown) {
            // pointerX is canvas-space; center paddle on pointerX
            const targetX = clamp(input.pointerX - this.width / 2, 12, WIDTH - 12 - this.width);
            // smooth move
            this.x = this.x + (targetX - this.x) * clamp(dt * 12, 0, 1);
          } else {
            if (move !== 0) {
              this.x += move * this.speed * dt;
              this.x = clamp(this.x, 12, WIDTH - 12 - this.width);
            } else {
              // slight easing to center edges
              this.x = clamp(this.x, 12, WIDTH - 12 - this.width);
            }
          }

          // power-up expiration
          if (this.expireTimer > 0) {
            this.expireTimer -= dt;
            if (this.expireTimer <= 0) {
              this.width = PADDLE_BASE_WIDTH;
            }
          }
        }

        applyPower(type) {
          if (type === 'paddle') {
            this.width = PADDLE_BASE_WIDTH * 1.6;
            this.expireTimer = 12; // lasts for 12 seconds
          }
        }

        draw(ctx) {
          // neon style paddle (rounded rectangle)
          ctx.save();
          ctx.fillStyle = '#041219';
          ctx.fillRect(this.x - 2, this.y - 2, this.width + 4, this.height + 4);
          // glow
          ctx.shadowColor = 'rgba(51,224,255,0.28)';
          ctx.shadowBlur = 10;
          ctx.fillStyle = 'linear-gradient(90deg,#33e0ff,#ff4dd2)';
          ctx.fillStyle = '#33e0ff';
          ctx.fillRect(this.x, this.y, this.width, this.height);
          ctx.restore();
        }

        // rectangle for collision
        getRect() {
          return { x: this.x, y: this.y, w: this.width, h: this.height };
        }
      }

      // Ball: simple physics, maintains velocity and position
      class Ball {
        constructor(x, y, speed = 360) {
          this.x = x;
          this.y = y;
          // initial velocity will be set on launch
          this.vx = 0;
          this.vy = 0;
          this.radius = BALL_RADIUS;
          this.speed = speed; // magnitude speed (px/s)
          this.stuck = true; // stuck to paddle until launch
          this.spin = 0; // visual spin
          this.color = '#ffd84d';
        }

        attachToPaddle(paddle) {
          this.stuck = true;
          this.x = paddle.x + paddle.width / 2;
          this.y = paddle.y - this.radius - 2;
        }

        launch(ang = -Math.PI / 4) {
          // ang is angle in radians measured from +x axis; but we'll use angle where up is negative y
          this.stuck = false;
          this.vx = this.speed * Math.cos(ang);
          this.vy = this.speed * Math.sin(ang);
        }

        setVelocityFromSpeed(angle) {
          this.vx = this.speed * Math.cos(angle);
          this.vy = this.speed * Math.sin(angle);
        }

        update(dt) {
          if (this.stuck) return;
          this.x += this.vx * dt;
          this.y += this.vy * dt;
          // basic wall collisions (left/right/top)
          if (this.x - this.radius <= 8) {
            this.x = 8 + this.radius; this.vx = Math.abs(this.vx);
          }
          if (this.x + this.radius >= WIDTH - 8) {
            this.x = WIDTH - 8 - this.radius; this.vx = -Math.abs(this.vx);
          }
          if (this.y - this.radius <= 8) {
            this.y = 8 + this.radius; this.vy = Math.abs(this.vy);
          }
          // bottom handled by game logic (ball lost)
        }

        // reflect off rectangular surface with normal (nx,ny)
        reflect(nx, ny, speedMultiplier = 1.0) {
          // reflect velocity vector across normal: v' = v - 2*(v·n)*n
          const vDotN = this.vx * nx + this.vy * ny;
          this.vx = this.vx - 2 * vDotN * nx;
          this.vy = this.vy - 2 * vDotN * ny;

          // normalize speed to maintain magnitude (with optional multiplier)
          const mag = Math.hypot(this.vx, this.vy) || 1;
          const desired = this.speed * speedMultiplier;
          this.vx = (this.vx / mag) * desired;
          this.vy = (this.vy / mag) * desired;
        }

        draw(ctx) {
          ctx.save();
          ctx.beginPath();
          ctx.fillStyle = '#041219';
          ctx.arc(this.x, this.y, this.radius + 2.5, 0, Math.PI * 2);
          ctx.fill();
          // neon glow
          ctx.shadowColor = '#ffd84d';
          ctx.shadowBlur = 18;
          ctx.beginPath();
          ctx.fillStyle = this.color;
          ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }

      // Brick: rectangular bricks with color and hp
      class Brick {
        constructor(x, y, w, h, color, hp = 1) {
          this.x = x; this.y = y; this.w = w; this.h = h;
          this.color = color; this.hp = hp;
          this.alive = true;
        }

        hit() {
          this.hp--;
          if (this.hp <= 0) this.alive = false;
        }

        draw(ctx) {
          if (!this.alive) return;
          // neon brick with inner highlight and border
          ctx.save();
          ctx.fillStyle = '#041219';
          ctx.fillRect(this.x - 2, this.y - 2, this.w + 4, this.h + 4);
          ctx.shadowColor = this.color;
          ctx.shadowBlur = 14;
          ctx.fillStyle = this.color;
          ctx.fillRect(this.x, this.y, this.w, this.h);
          // inner glow stripe
          ctx.shadowBlur = 0;
          ctx.fillStyle = 'rgba(255,255,255,0.12)';
          ctx.fillRect(this.x + 6, this.y + 4, this.w - 12, Math.floor(this.h / 3));
          ctx.restore();
        }
      }

      // PowerUp: falls down when spawned; types: multi, paddle, speed
      class PowerUp {
        constructor(x, y, type) {
          this.x = x; this.y = y; this.type = type;
          this.radius = 10;
          this.vy = 90; // falling speed px/s
          this.alive = true;
          this.duration = (type === 'speed') ? 10 : (type === 'paddle') ? 12 : 0; // seconds
        }

        update(dt) {
          this.y += this.vy * dt;
          if (this.y > HEIGHT + 40) this.alive = false;
        }

        draw(ctx) {
          ctx.save();
          ctx.beginPath();
          ctx.shadowBlur = 14;
          if (this.type === 'multi') { ctx.fillStyle = '#ff79d6'; ctx.shadowColor = '#ff4dd2'; }
          else if (this.type === 'paddle') { ctx.fillStyle = '#33e0ff'; ctx.shadowColor = '#33e0ff'; }
          else { ctx.fillStyle = '#ffd84d'; ctx.shadowColor = '#ffd84d'; }
          ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();

          // letter indicator
          ctx.save();
          ctx.fillStyle = '#041219';
          ctx.font = 'bold 12px monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const label = this.type === 'multi' ? 'M' : this.type === 'paddle' ? 'P' : 'S';
          ctx.fillText(label, this.x, this.y + 1);
          ctx.restore();
        }
      }

      /* -------------------------
         Level Manager: layouts & progression
         ------------------------- */
      class LevelManager {
        constructor() {
          this.level = 1;
          this.levels = this._generateLevels();
        }

        _generateLevels() {
          // produce several levels with varied patterns; returns array of brick arrays
          const levels = [];

          // Helper to create grid
          const makeGrid = (rows, cols, offsetX, offsetY, colors) => {
            const arr = [];
            for (let r = 0; r < rows; r++) {
              for (let c = 0; c < cols; c++) {
                const x = 40 + c * (BRICK_W + 2);
                const y = 60 + r * (BRICK_H + 6) + offsetY;
                const color = colors[(r + c) % colors.length];
                arr.push(new Brick(x, y, BRICK_W, BRICK_H, color));
              }
            }
            return arr;
          };

          // Level 1: classic rainbow grid
          levels.push(makeGrid(3, BRICK_COLS, 0, 0, ['#ff4dd2', '#33e0ff', '#7cff6a', '#ffd84d']));

          // Level 2: staggered with tougher bricks
          const lvl2 = [];
          for (let r = 0; r < 4; r++) {
            for (let c = 0; c < BRICK_COLS; c++) {
              if ((r + c) % 2 === 0) {
                lvl2.push(new Brick(40 + c * (BRICK_W + 2), 60 + r * (BRICK_H + 6), BRICK_W, BRICK_H, '#7cff6a', 2));
              } else {
                lvl2.push(new Brick(40 + c * (BRICK_W + 2), 60 + r * (BRICK_H + 6), BRICK_W, BRICK_H, '#33e0ff', 1));
              }
            }
          }
          levels.push(lvl2);

          // Level 3: walls and center diamond
          const lvl3 = [];
          for (let r = 0; r < 5; r++) {
            for (let c = 0; c < BRICK_COLS; c++) {
              if (c < 2 || c > BRICK_COLS - 3) continue; // columns removed to create gaps
              const x = 40 + c * (BRICK_W + 2);
              const y = 60 + r * (BRICK_H + 6);
              lvl3.push(new Brick(x, y, BRICK_W, BRICK_H, '#ff4dd2', (r === 2 && (c >= 4 && c <= 5)) ? 3 : 1));
            }
          }
          levels.push(lvl3);

          // Level 4+: generate pattern with increasing hp
          for (let L = 4; L <= 6; L++) {
            const arr = [];
            const rows = 3 + L - 1;
            for (let r = 0; r < rows; r++) {
              for (let c = 0; c < BRICK_COLS; c++) {
                const hp = 1 + Math.floor((r + c + L) / 6);
                const colors = ['#33e0ff', '#ff4dd2', '#ffd84d'];
                arr.push(new Brick(40 + c * (BRICK_W + 2), 60 + r * (BRICK_H + 6), BRICK_W, BRICK_H, colors[(r + c) % colors.length], hp));
              }
            }
            levels.push(arr);
          }

          return levels;
        }

        getBricksForLevel(n) {
          return JSON.parse(JSON.stringify(this.levels[n - 1]), (k, v) => {
            // reconstruct Brick objects (we serialized to plain objects)
            if (v && typeof v === 'object' && 'x' in v && 'w' in v && 'h' in v && 'color' in v) {
              const b = new Brick(v.x, v.y, v.w, v.h, v.color, v.hp);
              b.alive = v.alive;
              return b;
            }
            return v;
          });
        }

        maxLevel() { return this.levels.length; }
      }

      /* -------------------------
         Game class orchestrates everything
         ------------------------- */
      class Game {
        constructor() {
          this.state = STATE.READY;
          this.input = new Input(canvas);
          this.sound = new Sound();
          this.levelManager = new LevelManager();
          this.currentLevel = 1;
          this.bricks = this.levelManager.getBricksForLevel(this.currentLevel);
          this.paddle = new Paddle();
          this.balls = [new Ball(this.paddle.x + this.paddle.width / 2, this.paddle.y - BALL_RADIUS - 2)];
          this.balls[0].attachToPaddle(this.paddle);
          this.powerups = [];
          this.lives = 3;
          this.score = 0;
          this.lastTime = now();
          this.pauseFlag = false;
          this.scoreToAdd = 0;
          this.speedBoostTimer = 0;
          this.multiBallTimer = 0;
          this._bindUI();
          this.sound.startMusic();
          this._loop();
        }

        _bindUI() {
          btnStart.addEventListener('click', () => {
            if (this.state === STATE.READY || this.state === STATE.LEVEL_COMPLETE) this.startLevel();
            else if (this.state === STATE.PLAYING) { /* nothing */ }
          });
          btnPause.addEventListener('click', () => {
            if (this.state === STATE.PLAYING) this.togglePause();
            else if (this.state === STATE.PAUSED) this.togglePause();
          });
          btnReset.addEventListener('click', () => this.resetGame());

          // focus canvas for keyboard controls
          canvas.addEventListener('click', () => canvas.focus());
        }

        resetGame() {
          this.currentLevel = 1;
          this.bricks = this.levelManager.getBricksForLevel(this.currentLevel);
          this.paddle = new Paddle();
          this.balls = [new Ball(this.paddle.x + this.paddle.width / 2, this.paddle.y - BALL_RADIUS - 2)];
          this.balls[0].attachToPaddle(this.paddle);
          this.powerups = [];
          this.lives = 3;
          this.score = 0;
          this.state = STATE.READY;
          this.speedBoostTimer = 0;
          this.multiBallTimer = 0;
          this._updateHUD();
        }

        startLevel() {
          if (this.state === STATE.LEVEL_COMPLETE) {
            // advance
            this.currentLevel++;
            if (this.currentLevel > this.levelManager.maxLevel()) {
              this.currentLevel = 1; // wrap or end game
            }
            this.bricks = this.levelManager.getBricksForLevel(this.currentLevel);
          }
          // reset paddle/balls
          this.paddle = new Paddle();
          this.balls = [new Ball(this.paddle.x + this.paddle.width / 2, this.paddle.y - BALL_RADIUS - 2)];
          this.balls.forEach(b => b.attachToPaddle(this.paddle));
          this.powerups = [];
          this.state = STATE.PLAYING;
          this._updateHUD();
        }

        togglePause() {
          if (this.state === STATE.PLAYING) { this.state = STATE.PAUSED; btnPause.textContent = 'Resume'; }
          else if (this.state === STATE.PAUSED) { this.state = STATE.PLAYING; btnPause.textContent = 'Pause'; }
        }

        _updateHUD() {
          elLives.textContent = `LIVES: ${this.lives}`;
          elScore.textContent = `SCORE: ${this.score}`;
          elLevel.textContent = `LEVEL: ${this.currentLevel}`;
        }

        _loop() {
          const t = now();
          let dt = (t - this.lastTime) / 1000;
          if (dt > 0.05) dt = 0.05; // clamp
          this.lastTime = t;

          if (this.state === STATE.PLAYING) {
            this.update(dt);
          }
          this.draw();
          requestAnimationFrame(() => this._loop());
        }

        update(dt) {
          // Paddle movement (keyboard or touch)
          this.paddle.update(dt, this.input);

          // Ball updates
          for (const ball of this.balls) {
            if (ball.stuck) {
              // attach to paddle while stuck
              ball.x = this.paddle.x + this.paddle.width / 2;
              ball.y = this.paddle.y - ball.radius - 2;
              // launch if player pressed launch button
              if (this.input.launch) {
                // launch at a randomized upward angle for variety
                const angle = -Math.PI / 2 + (Math.random() * 0.6 - 0.3);
                ball.speed *= (this.speedBoostTimer > 0) ? 1.08 : 1.0;
                ball.vx = ball.speed * Math.cos(angle);
                ball.vy = ball.speed * Math.sin(angle);
                ball.stuck = false;
                this.input.launch = false;
              }
            } else {
              ball.update(dt);
            }
          }

          // Ball-paddle collisions
          for (const ball of this.balls) {
            if (ball.stuck) continue;
            const r = this.paddle.getRect();
            if (circleRectCollision(ball.x, ball.y, ball.radius, r.x, r.y, r.w, r.h)) {
              // compute hit factor based on where ball hits paddle; -1 left .. 1 right
              const relative = (ball.x - (r.x + r.w / 2)) / (r.w / 2);
              const bounceAngle = relative * (Math.PI / 3) - Math.PI / 2; // map to [-120deg, -60deg] roughly
              const speedMultiplier = (this.speedBoostTimer > 0) ? 1.08 : 1.0;
              ball.speed = clamp(ball.speed * speedMultiplier, 200, 820);
              // set velocity based on bounceAngle
              ball.vx = ball.speed * Math.cos(bounceAngle);
              ball.vy = ball.speed * Math.sin(bounceAngle);
              // small nudge upward to avoid repeated collisions
              ball.y = r.y - ball.radius - 1;
              this.sound.hit();
            }
          }

          // Ball-brick collisions
          for (const ball of this.balls) {
            if (ball.stuck) continue;
            for (const brick of this.bricks) {
              if (!brick.alive) continue;
              if (circleRectCollision(ball.x, ball.y, ball.radius, brick.x, brick.y, brick.w, brick.h)) {
                // Determine collision normal by checking penetration amounts
                const overlapX = Math.min(ball.x + ball.radius - brick.x, brick.x + brick.w - (ball.x - ball.radius));
                const overlapY = Math.min(ball.y + ball.radius - brick.y, brick.y + brick.h - (ball.y - ball.radius));
                if (overlapX < overlapY) {
                  // reflect horizontally
                  const nx = (ball.x < brick.x + brick.w / 2) ? -1 : 1;
                  ball.vx = -ball.vx;
                  ball.x += nx * overlapX;
                } else {
                  // reflect vertically
                  const ny = (ball.y < brick.y + brick.h / 2) ? -1 : 1;
                  ball.vy = -ball.vy;
                  ball.y += ny * overlapY;
                }

                // adjust speed slightly for feedback
                ball.speed = clamp(ball.speed * 1.01, 220, 900);

                brick.hit();
                const scoreGain = 100;
                this.score += scoreGain;
                this._updateHUD();
                this.sound.break();

                // spawn power-up occasionally when brick destroyed
                if (!brick.alive && Math.random() < POWER_CHANCE) {
                  const types = ['multi', 'paddle', 'speed'];
                  const ptype = randChoice(types);
                  this.powerups.push(new PowerUp(brick.x + brick.w / 2, brick.y + brick.h / 2, ptype));
                }
                break; // only one brick collision per update per ball
              }
            }
          }

          // update power-ups
          for (const p of this.powerups) p.update(dt);

          // collect power-ups with paddle
          for (let i = this.powerups.length - 1; i >= 0; i--) {
            const p = this.powerups[i];
            const r = this.paddle.getRect();
            if (circleRectCollision(p.x, p.y, p.radius, r.x, r.y, r.w, r.h)) {
              this.applyPowerUp(p.type);
              p.alive = false;
              this.sound.power();
              this.powerups.splice(i, 1);
            } else if (!p.alive) {
              this.powerups.splice(i, 1);
            }
          }

          // balls falling below screen -> lose ball
          for (let i = this.balls.length - 1; i >= 0; i--) {
            const b = this.balls[i];
            if (b.y - b.radius > HEIGHT + 8) {
              this.balls.splice(i, 1);
            }
          }

          // if no balls, lose life and reset to ready/attach ball to paddle or game over
          if (this.balls.length === 0) {
            this.lives--;
            this._updateHUD();
            if (this.lives <= 0) {
              this.state = STATE.GAME_OVER;
            } else {
              const ball = new Ball(this.paddle.x + this.paddle.width / 2, this.paddle.y - BALL_RADIUS - 2);
              ball.attachToPaddle(this.paddle);
              this.balls.push(ball);
              this.state = STATE.READY;
              // small pause briefly could be added
            }
          }

          // check level complete
          const remaining = this.bricks.filter(b => b.alive).length;
          if (remaining === 0) {
            this.state = STATE.LEVEL_COMPLETE;
            // advance or let user press Start to go next
            this.sound.break();
          }

          // timers for active power-ups (speed boost, multi-ball)
          if (this.speedBoostTimer > 0) {
            this.speedBoostTimer -= dt;
            if (this.speedBoostTimer <= 0) {
              // reset ball speeds to normal (not perfect if multiple boosts stacked, but sufficient)
              for (const b of this.balls) b.speed = 360;
            }
          }
          if (this.multiBallTimer > 0) {
            this.multiBallTimer -= dt;
          }
        }

        applyPowerUp(type) {
          if (type === 'multi') {
            // create two additional balls near current ball positions
            const newBalls = [];
            for (const b of this.balls) {
              // create two balls with slight angle offsets
              const speed = clamp(b.speed * 1.02, 260, 920);
              const a1 = Math.atan2(b.vy, b.vx) + 0.18;
              const a2 = Math.atan2(b.vy, b.vx) - 0.18;
              const b1 = new Ball(b.x + 8, b.y, speed);
              b1.vx = speed * Math.cos(a1); b1.vy = speed * Math.sin(a1); b1.stuck = false;
              const b2 = new Ball(b.x - 8, b.y, speed);
              b2.vx = speed * Math.cos(a2); b2.vy = speed * Math.sin(a2); b2.stuck = false;
              newBalls.push(b1, b2);
            }
            this.balls.push(...newBalls);
            this.multiBallTimer = 9.0; // duration visual indicator (not needed)
          } else if (type === 'paddle') {
            this.paddle.applyPower('paddle');
          } else if (type === 'speed') {
            // increase ball speeds temporarily
            for (const b of this.balls) {
              b.speed = clamp(b.speed * 1.18, 300, 1000);
              // adjust velocities proportionally
              const ang = Math.atan2(b.vy, b.vx);
              b.vx = b.speed * Math.cos(ang);
              b.vy = b.speed * Math.sin(ang);
            }
            this.speedBoostTimer = 10.0; // seconds
          }
        }

        draw() {
          // clear
          ctx.clearRect(0, 0, WIDTH, HEIGHT);

          // background grid / neon gradient
          drawBackground();

          // draw bricks
          for (const b of this.bricks) b.draw(ctx);

          // draw power-ups
          for (const p of this.powerups) p.draw(ctx);

          // draw paddle
          this.paddle.draw(ctx);

          // draw balls
          for (const b of this.balls) b.draw(ctx);

          // draw HUD overlays (center messages)
          if (this.state === STATE.READY) {
            drawCenteredText('Tap or Press Space to Launch', 20, '#ffd84d');
          } else if (this.state === STATE.PAUSED) {
            drawCenteredText('PAUSED', 34, '#33e0ff');
          } else if (this.state === STATE.LEVEL_COMPLETE) {
            drawCenteredText('LEVEL CLEARED!', 28, '#7cff6a');
          } else if (this.state === STATE.GAME_OVER) {
            drawCenteredText('GAME OVER', 34, '#ff4dd2');
            drawCenteredSubText('Press Reset to try again', 16, '#ffd84d');
          }
        }
      }

      /* -------------------------
         Collision helpers
         ------------------------- */
      function circleRectCollision(cx, cy, r, rx, ry, rw, rh) {
        const closestX = clamp(cx, rx, rx + rw);
        const closestY = clamp(cy, ry, ry + rh);
        const dx = cx - closestX;
        const dy = cy - closestY;
        return (dx * dx + dy * dy) < (r * r + 0.0001);
      }

      /* -------------------------
         Rendering helpers (neon background and text)
         ------------------------- */
      function drawBackground() {
        // neon gradient background with subtle grid
        const g = ctx.createLinearGradient(0, 0, 0, HEIGHT);
        g.addColorStop(0, '#040319');
        g.addColorStop(1, '#061226');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, WIDTH, HEIGHT);

        // grid
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.02)';
        ctx.lineWidth = 1;
        for (let x = 0; x < WIDTH; x += 40) {
          ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, HEIGHT); ctx.stroke();
        }
        for (let y = 0; y < HEIGHT; y += 40) {
          ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(WIDTH, y + 0.5); ctx.stroke();
        }
        ctx.restore();

        // neon overlay vignette
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const radial = ctx.createRadialGradient(WIDTH / 2, HEIGHT / 2, 40, WIDTH / 2, HEIGHT / 2, Math.max(WIDTH, HEIGHT));
        radial.addColorStop(0, 'rgba(72,56,116,0.06)');
        radial.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = radial;
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
        ctx.restore();
      }

      function drawCenteredText(text, size = 28, color = '#fff') {
        ctx.save();
        ctx.font = `bold ${size}px monospace`;
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowBlur = 12;
        ctx.shadowColor = color;
        ctx.fillText(text, WIDTH / 2, HEIGHT / 2 - 8);
        ctx.restore();
      }
      function drawCenteredSubText(text, size = 16, color = '#fff') {
        ctx.save();
        ctx.font = `${size}px monospace`;
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, WIDTH / 2, HEIGHT / 2 + 26);
        ctx.restore();
      }

      /* -------------------------
         Game initialization
         ------------------------- */
      const game = new Game();
      game._updateHUD = function () {
        elLives.textContent = `LIVES: ${this.lives}`;
        elScore.textContent = `SCORE: ${this.score}`;
        elLevel.textContent = `LEVEL: ${this.currentLevel}`;
      }.bind(game);

      // Expose for debugging
      window.NeonBricks = game;

      // Auto-start paused music in user gesture on first input (modern browsers)
      function enableAudioOnInteraction() {
        if (game.sound && game.sound.ctx && game.sound.ctx.state === 'suspended') {
          game.sound.ctx.resume();
        }
        window.removeEventListener('pointerdown', enableAudioOnInteraction);
        window.removeEventListener('keydown', enableAudioOnInteraction);
      }
      window.addEventListener('pointerdown', enableAudioOnInteraction);
      window.addEventListener('keydown', enableAudioOnInteraction);

    })();
  
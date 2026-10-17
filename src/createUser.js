// Usage:  node createUser.js <username> <password> [admin]
//  node --env-file=.env src/createUser.js username password
import bcrypt from 'bcryptjs';
import db from './db.js';

const [username, password, flag] = process.argv.slice(2);

if (!username || !password || password.length < 8) {
  console.error('Usage: node createUser.js <username> <password, 8+ characters> [admin]');
  process.exit(1);
}

const name = username.trim().toLowerCase();

if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(name)) {
  console.error('That username already exists.');
  process.exit(1);
}

db.prepare('INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, ?)')
  .run(name, bcrypt.hashSync(password, 10), flag === 'admin' ? 1 : 0);

console.log(`Created ${flag === 'admin' ? 'admin ' : ''}user: ${name}`);
import { getDb } from './database.js';
import bcrypt from 'bcrypt';

async function main() {
  const email = 'playstore-tester@goroomz.in';
  const password = 'TestPassword123!';

  console.log(`🚀 Creating Play Store tester account: ${email}...`);

  try {
    const db = await getDb();
    
    // Check if user already exists
    const existingUser = await db.get('SELECT id FROM users WHERE email = ?', [email]);
    let userId;

    if (existingUser) {
      console.log('💡 Tester account already exists. Updating password and verifying...');
      userId = existingUser.id;
      const hashedPassword = await bcrypt.hash(password, 10);
      await db.run(
        'UPDATE users SET password = ?, is_verified = 1, role = \'user\' WHERE id = ?',
        [hashedPassword, userId]
      );
    } else {
      const hashedPassword = await bcrypt.hash(password, 10);
      const result = await db.run(
        `INSERT INTO users (email, password, role, is_verified, verification_token, created_at)
         VALUES (?, ?, 'user', 1, NULL, ?)`,
        [email, hashedPassword, new Date().toISOString()]
      );
      userId = result.lastID;
      console.log('✅ Created new tester account successfully!');
    }

    // Add a dummy monitor so Google reviewers have data to see
    const existingMonitor = await db.get('SELECT id FROM monitors WHERE user_id = ?', [userId]);
    if (!existingMonitor) {
      await db.run(
        `INSERT INTO monitors (name, url, method, interval, timeout, status, active, user_id)
         VALUES ('Google Review Demo', 'https://example.com', 'GET', 60, 10, 'UP', 1, ?)`,
        [userId]
      );
      console.log('✅ Added "Google Review Demo" monitor to the tester account.');
    } else {
      console.log('💡 Tester account already has monitors configured.');
    }

    console.log('\n🎉 Setup complete! You can now use these credentials in the Google Play Console.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error creating tester account:', err.message);
    process.exit(1);
  }
}

main();

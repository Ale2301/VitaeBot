require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  try {
    const res = await pool.query("SELECT NOW()");
    console.log("Conexión OK ✅", res.rows[0]);
  } catch (err) {
    console.error("Error ❌", err);
  } finally {
    pool.end();
  }
})();

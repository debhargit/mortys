// Password + PIN hashing. bcryptjs is pure JS and runs on Workers (a hash is
// ~100ms of CPU — fine for sign-in, which is rare). Same cost factor (10) as
// server.js so existing hashes verify unchanged.
import bcrypt from 'bcryptjs';

export const hashPassword = (pw) => bcrypt.hash(String(pw), 10);
export const checkPassword = (pw, hash) => bcrypt.compare(String(pw), hash || '');

import { randomBytes } from "node:crypto";
import argon2 from "argon2";

export function hashPassword(password: string) {
  return argon2.hash(password, { type: argon2.argon2id });
}

export function verifyPassword(hash: string, password: string) {
  return argon2.verify(hash, password);
}

// A hash of a random secret, made with the same settings as real passwords.
// Login checks unknown emails against it so they cost the same argon2 time as
// known ones; deriving it (instead of hard-coding one) keeps its cost in step
// with hashPassword. The promise is memoized so concurrent first logins share it.
let dummyHash: Promise<string> | undefined;

export function dummyPasswordHash() {
  dummyHash ??= hashPassword(randomBytes(32).toString("base64url"));
  return dummyHash;
}

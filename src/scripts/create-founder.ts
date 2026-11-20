/**
 * Creates the very first staff account (role FOUNDER) so someone can sign in.
 *   npm run create-founder
 * It asks for the name, email and password. The password is not shown while you type and is never
 * printed or saved anywhere except as a hash in the database.
 * It refuses to run if a Founder already exists: further staff are added from the admin app.
 */
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { env } from '../config/env.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/connect.js';
import { UserModel } from '../models/index.js';
import { hashPassword, newPasswordSchema } from '../modules/auth/password.js';

/** Asks one question. `hidden` stops the typed text from appearing on screen. */
async function ask(question: string, hidden = false): Promise<string> {
  // readline clears the line when it starts, so it must print a visible question itself.
  // A hidden answer sends readline's output nowhere, so we print that question ourselves.
  if (hidden) process.stdout.write(question);
  const output = hidden
    ? new Writable({ write: (_chunk, _encoding, done) => done() })
    : process.stdout;
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const answer = await rl.question(hidden ? '' : question);
  rl.close();
  if (hidden) process.stdout.write('\n');
  return answer;
}

/** A Zod error's own message is a JSON dump, so show just its sentences. */
function readableReason(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => issue.message).join(' ');
  if (error instanceof Error) return error.message;
  return String(error);
}

async function main(): Promise<void> {
  // Without a real terminal the questions can never be answered, so stop now instead of waiting forever.
  if (!process.stdin.isTTY) {
    throw new Error('Run this in an interactive terminal: it asks you questions.');
  }

  await connectToDatabase(env.mongodbUri);

  if (await UserModel.exists({ role: 'FOUNDER' })) {
    console.log('A Founder account already exists. Add more staff from the admin app instead.');
    return;
  }

  const name = z
    .string()
    .trim()
    .min(1, 'Enter a name.')
    .max(100, 'Use at most 100 characters for the name.')
    .parse(await ask('Name: '));
  const email = z.email('Enter a valid email address.').parse((await ask('Email: ')).trim());
  const password = newPasswordSchema.parse(await ask('Password (min 10 characters): ', true));
  if (password !== (await ask('Repeat password: ', true))) {
    throw new Error('The two passwords are different. Nothing was created.');
  }

  await UserModel.create({
    name,
    email,
    role: 'FOUNDER',
    passwordHash: await hashPassword(password),
    mustChangePassword: false, // they just chose this password themselves
  });
  console.log(`Created Founder account for ${email}. You can sign in now.`);
}

main()
  .catch((error: unknown) => {
    console.error('create-founder failed:', readableReason(error));
    process.exitCode = 1;
  })
  .finally(() => void disconnectFromDatabase());

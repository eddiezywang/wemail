#!/usr/bin/env node
import { assertProductionLoginEnv } from "./production-login-env.mjs";

// Run before cleaning outputs; build:desktop uses Vite's production mode.
assertProductionLoginEnv("production", process.cwd());

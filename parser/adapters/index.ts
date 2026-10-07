import type { Adapter } from "../adapter.ts";
import { aspnet } from "./aspnet.ts";
import { django } from "./django.ts";
import { fastapi, flask } from "./fastapi-flask.ts";
import { chi, echo, fiber, gin } from "./go-web.ts";
import { jaxrs, micronaut, spring } from "./jvm-web.ts";
import { ktor } from "./ktor.ts";
import { phoenix, rocket, symfony } from "./more-web.ts";
import { angular, astro, nuxt, remix, sveltekit, vue } from "./js-files.ts";
import { fastify, hono, koa } from "./js-servers.ts";
import { laravel } from "./laravel.ts";
import { nestjs } from "./nestjs.ts";
import { nextjs } from "./nextjs.ts";
import { litestar, starlette } from "./python-more.ts";
import { rails } from "./rails.ts";
import { react } from "./react.ts";
import { actix, axum } from "./rust-web.ts";
import { vapor } from "./vapor.ts";

// Detection order. Every adapter claims the packages that declare it; where
// two claim the same directory for the same files, the earlier one wins.
// Meta-frameworks come before the libraries they're built on (Next.js and
// Remix before React, Nuxt before Vue), since their projects depend on both.
export const ADAPTERS: readonly Adapter[] = [nextjs, nuxt, sveltekit, remix, astro, nestjs, fastify, hono, koa, angular, vue, react, fastapi, litestar, starlette, django, flask, spring, micronaut, jaxrs, ktor, aspnet, gin, echo, chi, fiber, actix, axum, rocket, rails, laravel, symfony, phoenix, vapor];

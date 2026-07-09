# Sample Repo

A tiny fixture repository used exclusively by the substrate integration e2e
test (`tools/e2e/substrate-pipeline.test.mjs`). It is intentionally small: a
couple of source files plus this document, enough to exercise every stage of
the pipeline (source-provider -> ingest chunking -> embedding -> vector
search + rerank -> claim verification) without needing network access or a
git clone.

## Overview

This repository implements small utility functions for arithmetic and
greetings, used only as fixture content for retrieval and grounding tests.

## Fibonacci

The `fibonacci` function in `src/math.ts` computes the nth Fibonacci number
using an iterative loop that keeps two running totals, deliberately avoiding
recursion so that it stays fast and stack-safe for large inputs.

## Weather in Paris

Paris is the capital of France and is well known for the Eiffel Tower and
the Seine river running through the middle of the city.

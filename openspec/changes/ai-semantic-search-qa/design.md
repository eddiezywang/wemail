# AI Semantic Search QA - Design

## Index

Store account id, email id, chunk id, chunk text or sanitized text reference, embedding/vector when available, lexical terms, processor version, and indexed timestamp.

## Search

Search first tries embeddings when configured. If unavailable or failing, it degrades to lexical chunk search without blocking normal mail sync or list routes.

## QA

QA answers must cite every factual claim. If retrieved chunks do not support an answer, return a no-evidence result rather than guessing.

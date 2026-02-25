# Python Coding Standards

Applies to any Python code in the project (scripts, tooling, future agent integrations). Type hints and linting are non-negotiable.

## Type Hints

- Type hints are required on all public functions — parameters and return type. No exceptions.
- Use `from __future__ import annotations` at the top of every file to enable PEP 604 union syntax (`X | Y`) on older Pythons.
- For complex types, define named type aliases or dataclasses rather than inline `dict[str, Any]`.
- Avoid `Any`. If unavoidable, add a comment explaining why.
- Use `TypedDict` for dictionary shapes that cross module boundaries.

```python
from __future__ import annotations
from typing import TypedDict

class MemoryEntry(TypedDict):
    id: str
    category: str
    content: str
    created_by: str

def search_memory(query: str, limit: int = 10) -> list[MemoryEntry]:
    ...
```

## Docstrings

Use Google-style docstrings on all public modules, classes, and functions.

```python
def resolve_standard(path: str, project_root: str | None = None) -> str:
    """Resolve a standards URI through the three-tier override chain.

    Walks agent-specific → project overrides → system defaults and returns
    the content of the first match. Raises FileNotFoundError if the standard
    does not exist in any tier.

    Args:
        path: Standards path relative to the standards/ root (e.g.,
            "coding-standards/typescript").
        project_root: Absolute path to the project directory. If provided,
            checks .sdlc/standards/ for project overrides.

    Returns:
        The content of the resolved standards file as a string.

    Raises:
        FileNotFoundError: If the standard is not found in any tier.
    """
```

## Linting and Formatting

- **ruff**: primary linter and formatter. Run `ruff check .` and `ruff format .`. Configuration in `pyproject.toml`.
- **mypy**: type checker in strict mode (`mypy --strict`). All type errors must be resolved, not ignored.
- No `# type: ignore` without a comment explaining why.
- Line length: 88 characters (ruff default).

## Project Structure

- Use `pyproject.toml` for package metadata and tool configuration. No `setup.py`.
- Dependencies in `[project.dependencies]`; dev dependencies in `[dependency-groups]` or `[project.optional-dependencies]`.
- One module = one clear responsibility. If a module is doing more than one thing, split it.

## Structured Data

- Prefer `dataclasses` (stdlib) or `Pydantic` models for structured data that crosses module or process boundaries.
- Do not pass raw `dict` objects as function arguments when a typed dataclass or TypedDict would be clearer.
- Use `@dataclass(frozen=True)` for immutable value objects.

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class AuditEvent:
    id: str
    timestamp: str
    agent_id: str
    event_type: str
    action: str
    result: str
```

## Error Handling

- Define custom exception classes for domain errors. Inherit from `Exception`, not `BaseException`.
- Never use bare `except:` or `except Exception:` that silences errors. Catch specific exceptions.
- Add context when re-raising: `raise RuntimeError("failed to resolve standard") from original_error`.
- Log errors with enough context to diagnose the failure (what was being attempted, with what inputs).

## Imports

Order: stdlib → third-party → local. Separate groups with blank lines. Use absolute imports for local modules.

## Documentation

- Module-level docstring on every file: what it does, where it fits in the system.
- Link to architecture doc sections when implementing something described there.

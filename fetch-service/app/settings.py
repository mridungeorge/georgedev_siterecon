import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    # Shared with the Next.js app. The service refuses to start without one.
    secret: str
    # A browser is only started when at least this much memory is free (the VM has 1 GB in total).
    min_available_mb: int = 400
    render_timeout_ms: int = 45_000
    jina_base: str = "https://r.jina.ai"

    @staticmethod
    def from_env() -> "Settings":
        return Settings(
            secret=os.environ.get("FETCH_SERVICE_SECRET", ""),
            min_available_mb=int(os.environ.get("RENDER_MIN_AVAILABLE_MB", "400")),
            render_timeout_ms=int(os.environ.get("RENDER_TIMEOUT_MS", "45000")),
        )

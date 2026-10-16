class FinanceError(ValueError):
    """A rejected operation. Carries every reason so callers can report all of them."""

    def __init__(self, message: str, reasons: list[str] | None = None):
        super().__init__(message)
        self.reasons = list(reasons or [])

def fetch():
    try:
        read()
    except Exception:
        log()
        raise

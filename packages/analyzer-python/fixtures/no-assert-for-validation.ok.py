def process(value):
    if value <= 0:
        raise ValueError("value must be positive")
    return value

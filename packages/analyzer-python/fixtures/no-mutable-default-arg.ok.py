def append(item, items=None):
    if items is None:
        items = []
    items.append(item)
    return items


def other(x=()):
    return x

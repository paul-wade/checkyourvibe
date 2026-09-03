namespace Fixtures;

class Registry
{
    string? Find(string key) => key.Length > 0 ? key : null;

    void Use(string key)
    {
        // Asserts the result is not null without ever checking it.
        string found = Find(key)!;
        System.Console.WriteLine(found.Length);
    }
}

namespace Fixtures;

class Registry
{
    string? Find(string key) => key.Length > 0 ? key : null;

    // Inequality (`!=`) and logical negation (`!x`) both use the same "!" character but are a
    // different syntax construct entirely from the null-forgiving operator. A naive text search
    // for "!" would flag both of these; the rule must not.
    void Use(string key, bool ready)
    {
        if (key != string.Empty && !ready)
        {
            System.Console.WriteLine("not ready");
        }

        // The honest alternative: check for null before using the value.
        string? found = Find(key);
        if (found is not null)
        {
            System.Console.WriteLine(found.Length);
        }
    }
}

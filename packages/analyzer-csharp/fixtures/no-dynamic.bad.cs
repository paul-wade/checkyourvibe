using System;

namespace Fixtures;

class Loader
{
    // A dynamic-typed local. No member of it is checked until the program runs.
    void Load()
    {
        dynamic settings = FetchSettings();
        Console.WriteLine(settings.Timeout);
    }

    // A dynamic parameter and a dynamic return type both count too.
    dynamic Transform(dynamic input)
    {
        return input.Value;
    }

    static object FetchSettings() => new object();
}

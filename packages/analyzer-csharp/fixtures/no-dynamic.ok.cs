using System;

namespace Fixtures;

class Loader
{
    // "dynamic" is only a contextual keyword: a variable, parameter, or method may legally be
    // named "dynamic" without becoming the dynamic type. A naive text search for the word would
    // flag all of these; the rule must not, because the compiler resolves each one to `int`.
    void Load()
    {
        int dynamic = 5;
        Console.WriteLine(dynamic + 1);
        Report(dynamic);
    }

    void Report(int dynamic)
    {
        Console.WriteLine(dynamic);
    }

    static int dynamic() => 42;
}

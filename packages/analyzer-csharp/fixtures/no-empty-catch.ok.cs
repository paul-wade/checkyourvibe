using System;
using System.IO;

namespace Fixtures;

class Saver
{
    // A rethrow observes the exception (it decided not to handle it here) and preserves it for
    // whoever called this method. It must not be flagged as swallowing.
    void SaveAndRethrow(string path, string contents)
    {
        try
        {
            File.WriteAllText(path, contents);
        }
        catch (IOException)
        {
            throw;
        }
    }

    // A catch block that does something observable -- logging, in this case -- is not empty and
    // must not be flagged, even though it still lets execution continue afterward.
    void SaveAndLog(string path, string contents)
    {
        try
        {
            File.WriteAllText(path, contents);
        }
        catch (IOException ex)
        {
            Console.Error.WriteLine($"failed to save {path}: {ex.Message}");
        }
    }

    // Logging then continuing the loop is handling: the failure is recorded, not swallowed.
    void LoopAndLogContinue(string path, string contents)
    {
        foreach (var c in path)
        {
            try
            {
                File.WriteAllText(path, contents);
            }
            catch (IOException ex)
            {
                Console.Error.WriteLine($"failed to save {path}: {ex.Message}");
                continue;
            }
        }
    }

    // Logging then breaking the loop is handling: the failure is recorded, not swallowed.
    void LoopAndLogBreak(string path, string contents)
    {
        foreach (var c in path)
        {
            try
            {
                File.WriteAllText(path, contents);
            }
            catch (IOException ex)
            {
                Console.Error.WriteLine($"failed to save {path}: {ex.Message}");
                break;
            }
        }
    }

    // Returning a fallback value is a response to the failure, not swallowing.
    string TryOrFallback(string path, string contents)
    {
        try
        {
            File.WriteAllText(path, contents);
            return "ok";
        }
        catch (IOException)
        {
            return "fallback";
        }
    }
}

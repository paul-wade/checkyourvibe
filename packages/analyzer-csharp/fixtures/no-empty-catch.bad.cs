using System;
using System.IO;

namespace Fixtures;

class Saver
{
    void SaveQuietly(string path, string contents)
    {
        try
        {
            File.WriteAllText(path, contents);
        }
        catch (IOException)
        {
            // Nothing here. The failure is discarded and the caller has no idea it happened.
        }
    }

    void SaveQuietlyStill(string path, string contents)
    {
        try
        {
            File.WriteAllText(path, contents);
        }
        catch (IOException)
        {
            ;
        }
    }

    void LoopAndContinue(string path, string contents)
    {
        foreach (var c in path)
        {
            try
            {
                File.WriteAllText(path, contents);
            }
            catch (IOException)
            {
                continue;
            }
        }
    }

    void LoopAndBreak(string path, string contents)
    {
        foreach (var c in path)
        {
            try
            {
                File.WriteAllText(path, contents);
            }
            catch (IOException)
            {
                break;
            }
        }
    }

    void Bail(string path, string contents)
    {
        try
        {
            File.WriteAllText(path, contents);
        }
        catch (IOException)
        {
            return;
        }
    }
}

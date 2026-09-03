using System;

namespace Fixtures;

class Animal { }
class Dog : Animal { public void Bark() => Console.WriteLine("woof"); }

class Handler
{
    // Downcast to a derived reference type: throws InvalidCastException if the value is not
    // actually a Dog.
    void HandleAnimal(Animal animal)
    {
        var dog = (Dog)animal;
        dog.Bark();
    }

    // Unboxing an object back to a value type: throws InvalidCastException if the boxed value
    // is not actually an int.
    void HandleBoxed(object boxed)
    {
        var n = (int)boxed;
        Console.WriteLine(n);
    }
}

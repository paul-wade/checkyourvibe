using System;

namespace Fixtures;

class Animal { }
class Dog : Animal { public void Bark() => Console.WriteLine("woof"); }

class Handler
{
    // Numeric conversions between primitives are ordinary arithmetic, not a risky cast, even
    // when narrowing (double -> int) or explicit.
    void Numeric(double amount)
    {
        int whole = (int)amount;
        long widened = (long)whole;
        Console.WriteLine(whole + widened);
    }

    // An upcast to a base type can never fail -- it is legal even without the cast -- so it is
    // not flagged, unlike the downcast in the .bad fixture.
    void Upcast(Dog dog)
    {
        Animal animal = (Animal)dog;
        Console.WriteLine(animal);
    }

    // The honest alternative this rule asks for: pattern matching instead of a direct cast.
    void HandleAnimal(Animal animal)
    {
        if (animal is Dog dog)
        {
            dog.Bark();
        }
    }

    // Also honest: `as` plus a null check.
    void HandleBoxed(object boxed)
    {
        var maybeDog = boxed as Dog;
        if (maybeDog is not null)
        {
            maybeDog.Bark();
        }
    }
}

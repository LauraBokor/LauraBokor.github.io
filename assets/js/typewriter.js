var app = document.getElementById('type');

var typewriter = new Typewriter(app, {
    loop: true
});

typewriter.typeString('Hello!')
    .pauseFor(2500)
    .deleteAll()
    .typeString('I am Laura')
    .pauseFor(2500)
    .deleteChars(14)
    .typeString('A super excited Frontend Developer')
    .pauseFor(2500)
    .start();
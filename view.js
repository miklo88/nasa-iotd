const apiOBJ = new API();

var data = apiOBJ
  .getNASAAPI()
  .then((data) => {
    console.log("VIEWJS DATA: ", data);
    renderData(data);
  })
  .catch(`Error: ${Error}`);

window.setTimeout(startTimer1, 6000);
function startTimer1() {
  console.log("NASA");
}
window.setTimeout(startTimer2, 7000);
function startTimer2() {
  console.log("Image");
}
window.setTimeout(startTimer3, 8000);
function startTimer3() {
  console.log("of");
}
window.setTimeout(startTimer4, 8500);
function startTimer4() {
  console.log("the");
}
window.setTimeout(startTimer5, 9000);
function startTimer5() {
  console.log("Day");
}

function renderData(data) {
  //grab obj from broswer. add data to it.
  // console.log(data);
  let body = document.querySelector("body");
  let iotdContainer = document.getElementById("iotd");

  if (data == undefined || data == null) {
    let titleError = document.createElement("h2");
    titleError = textContent(
      "Oops, looks like we didn't get what we wanted today. Its ok, fuck it and try again tomorrow :D"
    );
    body.appendChild(titleError);
  } else {
    //creating the DOM elements
    let title = document.createElement("h3");
    let div = document.createElement("div");
    let explanation = document.createElement("p");
    let date = document.createElement("p");
    let imgURL = document.createElement("img");

    //creating their css class names
    div.className = "image-details";
    title.className = "response-title";
    explanation.className = "explanation";
    date.className = "date";
    imgURL.className = "iotd-image";

    title.textContent = `${data.title}`;
    explanation.textContent = `${data.explanation}`;
    date.textContent = `${data.date}`;
    imgURL.src = data.url;

    div.appendChild(explanation);
    div.appendChild(date);

    iotdContainer.appendChild(title);
    iotdContainer.appendChild(imgURL);
    iotdContainer.appendChild(div);

    body.appendChild(iotdContainer);
  }
}

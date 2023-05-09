// import showCard from "./showCard.js";
import StateObject from "/stateObject.js";
import DisplayCard from "/showCard.js";
const nasaList = new NASAPopular();
const displayCard = new DisplayCard();

class NasaView extends StateObject {
  constructor() {
    super();
    this.currentState;
    this.storeItemList;
    this.hasState;
    this.getState();
  }
}

nasaList
  .nasaPopularList()
  .then((data) => {
    renderNASACards(data["collection"]["items"]);
  })
  .catch(`Error: ${Error}`);

//setting the image on the DOM
function setImage(
  i,
  image,
  title,
  dateCreated,
  description,
  nasa_id,
  cardContainer,
  cardContainerId,
  container,
  body
) {
  //change this to only select the last url in the array. also consider if length = 1 and null + unidentified
  console.log("links length", i["links"]);
  for (var k of i["links"]) {
    image.src = k["href"];
    // console.log("links length", k["href"]);
  }
  cardContainer.appendChild(image);
  cardContainer.appendChild(title);

  cardContainer.appendChild(dateCreated);
  cardContainer.appendChild(description);
  container.appendChild(cardContainer);
  body.appendChild(container);
  console.log("cardContainer", cardContainer);
  console.log(typeof cardContainer);
}

//add function + logic
function getCurrentCardInfo(e) {
  //building the showCardContainer containing the selected element

  var showCardContainer = document.getElementById(e.target.id);
  // setting the items to local storage
  var imgCard = showCardContainer.childNodes[0];
  localStorage.setItem("imgCard", imgCard.src);
  // console.log(imgCard);
  var pCardT = showCardContainer.childNodes[1];
  localStorage.setItem("pCardT", pCardT.innerHTML);
  // console.log(pCardT);
  var pCardDC = showCardContainer.childNodes[2];
  localStorage.setItem("pCardDC", pCardDC.innerHTML);
  // console.log(pCardDC);
  var pCardD = showCardContainer.childNodes[3];
  localStorage.setItem("pCardD", pCardD.innerHTML);
  // console.log(pCardD);
  var nasa_id = showCardContainer.getAttribute("nasa_id");
  localStorage.setItem("nasa_id", nasa_id);
  console.log("localStorage nasa_id", nasa_id);
  var container_id = showCardContainer.getAttribute("id");
  localStorage.setItem("container_id", container_id);
  console.log("localStorage container_id", container_id);

  console.log("e.target", e.target);
  console.log("showCardContainer", showCardContainer);
  // const name = prompt("Please enter your name.");
  displayCard.renderCard(showCardContainer);
}
//renders grid of images from nasa
function renderNASACards(data) {
  //create a container for an img, title and descrtiion
  var body = document.querySelector("body");
  var container = document.createElement("div");
  container.setAttribute("id", "nasa-images");
  let cardContainerId = 0;
  //iteration/slicing of the collection response.
  for (var i of data) {
    //container card build
    for (var j of i["data"]) {
      // console.log(j);
      // if (j["media_type"] != "image") {
      if (j["media_type"] === "image") {
        cardContainerId++;
        //creating elements and their classes for styling.
        var cardContainer = document.createElement("div");
        var description = document.createElement("p");
        var dateCreated = document.createElement("p");
        var title = document.createElement("p");
        var image = document.createElement("img");

        container.className = "container";
        cardContainer.className = "card-container";

        cardContainer.setAttribute("id", cardContainerId);
        image.setAttribute("id", cardContainerId);

        description.className = "card-description";
        dateCreated.className = "card-date_created";
        title.className = "card-title";
        image.className = "card-image";

        // getCurrentCardInfo(greeting);
        image.addEventListener("click", getCurrentCardInfo);

        console.log("i", i);
        console.log("data:", i["data"]);
        //call image function
        title.textContent = j["title"];
        description.textContent = j["description"];
        dateCreated.textContent = j["date_created"];
        var nasa_id = j["nasa_id"];
        cardContainer.setAttribute("nasa_id", j["nasa_id"]);
        console.log(nasa_id);

        setImage(
          i,
          image,
          title,
          dateCreated,
          description,
          nasa_id,
          cardContainer,
          cardContainerId,
          container,
          body
        );
      } else {
        // console.log("NOT PHOTO", j["media_type"]);
        // j["media_type"] = "";
        console.log(j["media_type"]);
        return null;
      }
    }

    // console.log("links:", i["links"]);
  }
}
export default NasaView;

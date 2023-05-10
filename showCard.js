import StateObject from "./stateObject.js";

//onclick to show the full selected image detail
export default class DisplayCard {
  constructor() {}
  //callback
  renderCard(showCardContainer) {
    //check to see if container already exists
    const cleanup = document.getElementsByClassName("new-card-container");
    const bodyCleanup = document.querySelector("body");
    // console.log(cleanup);
    // console.log(typeof cleanup);
    // console.log(cleanup.length);
    // console.log(bodyCleanup);
    // cleanup.remove();
    // console.log(cleanup);
    if (cleanup.length > 0) {
      console.log("Delete and build a new container");
      // console.log(cleanup);
      // console.log(bodyCleanup);
      let removingItem = cleanup[0];
      removingItem.remove();
      console.log("Removed item", removingItem);
      // console.log(cleanup);
    } else {
      console.log("NEW CONTAINER RENDER");
      // cleanup.style.display = "none";
      // cleanup.HTMLCollection.pop();
    }
    //setting state
    console.log("showCardContainer in DisplayCard", showCardContainer);
    console.log(typeof showCardContainer);
    const stateObject = new StateObject();
    var state = stateObject.getState();
    console.log(state);
    //grabbing items from localstorage
    const img = localStorage.getItem("imgCard");
    const title = localStorage.getItem("pCardT");
    const dateCreated = localStorage.getItem("pCardDC");
    const description = localStorage.getItem("pCardD");

    function homeView(e) {
      iotdView.style.display = "grid";
      nasaContainer.style.display = "flex";
      newCardContainer.style.display = "none";
      console.log("HOME CLICKED", e.target);
    }

    console.log("BUILDING LAYOUT");
    let newCardBody = document.querySelector("body");
    let iotdView = document.getElementById("iotd");
    let nasaContainer = document.getElementById("nasa-images");
    let buttonContainer = document.createElement("div");
    let homeButton = document.createElement("button");
    let previousButton = document.createElement("button");
    let nextButton = document.createElement("button");

    homeButton.addEventListener("click", homeView);
    //LEFT CLICK PREVIOUS BUTTON
    previousButton.onclick = function clickLeft() {
      console.log("LEFT CLICK");

      var cardID = localStorage.getItem("nasa_id");
      console.log(cardID);
      console.log(stateObject.getState());
      state = stateObject.getState();

      console.log("getState", state);

      for (var i = 0; state.length > i; i++) {
        console.log(state[i]);
        if (cardID === state[i]["nasa_id"]) {
          console.log(i);
          console.log(
            `MATCH: cardID ${cardID} and i[nasa_id] ${state[i]["nasa_id"]} match `
          );
          // newDisplayCard = new DisplayCard();
          i--;
          var nextItem = {};
          nextItem = state[i];
          stateObject.moveLeft(nextItem);
          //call the renderCard function
          // console.log("next item in list", i);
          console.log(nextItem);
          console.log(`NEXT ITEM IN LIST:${i} : ${nextItem}`);
          console.log(`NEXT ITEM NASA_ID:${nextItem["nasa_id"]}`);
          console.log(`NEXT ITEM TITLE:${nextItem["title"]}`);
          console.log(`NEXT ITEM DESCRIPTION:${nextItem["description"]}`);
          console.log(`NEXT ITEM DATE_CREATED:${nextItem["dateCreated"]}`);
          console.log(`NEXT ITEM IMAGE:${nextItem["image"]}`);
        } else {
          console.log("ELSE HIT");
        }
      }
      console.log("LEAVING MOVE LEFT");
    };
    //RIGHT CLICK NEXT BUTTON
    nextButton.onclick = function clickRight() {
      console.log("RIGHT CLICK");

      var cardID = localStorage.getItem("nasa_id");
      console.log(cardID);
      console.log(stateObject.getState());
      state = stateObject.getState();

      console.log("getState", state);

      for (var i = 0; state.length > i; i++) {
        console.log(state[i]);
        if (cardID === state[i]["nasa_id"]) {
          console.log(i);
          console.log(
            `MATCH: cardID ${cardID} and i[nasa_id] ${state[i]["nasa_id"]} match `
          );
          // newDisplayCard = new DisplayCard();
          i++;
          var nextItem = {};
          nextItem = state[i];
          stateObject.moveRight(nextItem);
          //call the renderCard function
          // console.log("next item in list", i);
          console.log(nextItem);
          console.log(`NEXT ITEM IN LIST:${i} : ${nextItem}`);
          console.log(`NEXT ITEM NASA_ID:${nextItem["nasa_id"]}`);
          console.log(`NEXT ITEM TITLE:${nextItem["title"]}`);
          console.log(`NEXT ITEM DESCRIPTION:${nextItem["description"]}`);
          console.log(`NEXT ITEM DATE_CREATED:${nextItem["dateCreated"]}`);
          console.log(`NEXT ITEM IMAGE:${nextItem["image"]}`);
        } else {
          console.log("ELSE HIT");
        }
      }
      console.log("LEAVING MOVE RIGHT");
    };

    let newCardContainer = document.createElement("div");
    let newCardImg = document.createElement("img");
    let newCardTitle = document.createElement("p");
    let newCardDateCreated = document.createElement("p");
    let newCardDescription = document.createElement("p");

    newCardContainer.className = "new-card-container";
    newCardImg.className = "new-card-image";
    newCardTitle.className = "new-card-title";
    newCardDateCreated.className = "new-card-date-created";
    newCardDescription.className = "new-card-description";
    buttonContainer.className = "button-container";

    homeButton.className = "home-button";
    previousButton.className = "previous-button";
    nextButton.className = "next-button";

    iotdView.style.display = "none";
    nasaContainer.style.display = "none";
    newCardImg.src = img;
    newCardTitle.innerHTML = title;
    newCardDateCreated.innerHTML = dateCreated;
    newCardDescription.innerHTML = description;
    homeButton.innerHTML = "Home";
    previousButton.innerHTML = "<";
    nextButton.innerHTML = ">";

    newCardContainer.appendChild(newCardImg);
    newCardContainer.appendChild(newCardTitle);
    newCardContainer.appendChild(newCardDescription);
    newCardContainer.appendChild(newCardDateCreated);
    newCardContainer.appendChild(buttonContainer);
    buttonContainer.appendChild(previousButton);
    buttonContainer.appendChild(homeButton);
    buttonContainer.appendChild(nextButton);
    newCardBody.appendChild(newCardContainer);
  }
}

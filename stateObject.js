import DisplayCard from "./showCard.js";
const nasaList = new NASAPopular();

export default class StateObject {
  constructor() {
    this.storeItemList = [];
    this.hasState = false;
  }

  //add a function as a property to the state object to do CRUD operations via state.
  //get state
  getState() {
    // const state = this.currentState;
    if (this.hasState === false) {
      console.log("IF STATEMENT");
      nasaList
        .nasaPopularList()
        .then((data) => {
          // data["collection"]["items"];
          console.log(data["collection"]["items"]);
          let stateOBJECT = {};
          this.hasState = true;
          //iteration/slicing of the collection response.
          for (var i of data["collection"]["items"]) {
            stateOBJECT = new Object();

            for (var j of i["data"]) {
              // console.log(j);

              if (j["media_type"] === "image") {
                stateOBJECT.title = j["title"];
                stateOBJECT.description = j["description"];
                stateOBJECT.dateCreated = j["date_created"];
                stateOBJECT.nasa_id = j["nasa_id"];
                // console.log("NASA_ID SETSTATE", stateOBJECT.nasa_id);

                for (var k of i["links"]) {
                  stateOBJECT.image = k["href"];
                  // console.log("links length", k["href"]);
                }
                // this.storeItemList.push(stateOBJECT);
              } else {
                console.log(j["media_type"]);
                return null;
              }
            }
            // console.log(stateOBJECT);
            this.storeItemList.push(stateOBJECT);
          }
          var modifiedData = this.storeItemList;
          console.log(modifiedData);
          return modifiedData;
          // var modifiedData = this.storeItemList;
          // console.log(modifiedData);
          // return modifiedData;
        })
        .catch(`Error: ${Error}`);
    } else {
      console.log("GETTING STATE", this.storeItemList);
      var modifiedData = this.storeItemList;
      console.log(modifiedData);
      return modifiedData;
    }

    // if (this.currentState.length < 1) return this.currentState;
  }

  //grab the data from localstorage, find the id then iterate////////////////////////////////////////////////
  moveLeft(nextItem) {
    {
      console.log(nextItem);

      if ((this.storeItemList.length = 0)) {
        console.log("NO STATE SET");
      } else {
        const displayCard = new DisplayCard();
        var value = "state right deliverables";
        console.log("HELLO STATE LEFT", value);
        console.log("nextItem", nextItem);
        console.log(typeof nextItem);

        localStorage.clear();

        localStorage.setItem("imgCard", nextItem.image);
        console.log(nextItem.image);
        localStorage.setItem("pCardT", nextItem.title);
        // console.log(pCardT);
        localStorage.setItem("pCardDC", nextItem.dateCreated);
        // console.log(pCardDC);
        localStorage.setItem("pCardD", nextItem.description);
        // console.log(pCardD);
        localStorage.setItem("nasa_id", nextItem.nasa_id);
        console.log("localStorage nasa_id", nextItem.nasa_id);

        // console.log("e.target", e.target);
        // console.log("showCardContainer", showCardContainer);
        displayCard.renderCard(nextItem);
      }
    }
  }
  ////////////////////////////////////////////////////////////////////////////////////////////////
  moveRight(nextItem) {
    console.log(nextItem);

    if ((this.storeItemList.length = 0)) {
      console.log("NO STATE SET");
    } else {
      const displayCard = new DisplayCard();
      var value = "state right deliverables";
      console.log("HELLO STATE RIGHT", value);
      console.log("nextItem", nextItem);
      console.log(typeof nextItem);

      localStorage.clear();

      localStorage.setItem("imgCard", nextItem.image);
      console.log(nextItem.image);
      localStorage.setItem("pCardT", nextItem.title);
      // console.log(pCardT);
      localStorage.setItem("pCardDC", nextItem.dateCreated);
      // console.log(pCardDC);
      localStorage.setItem("pCardD", nextItem.description);
      // console.log(pCardD);
      localStorage.setItem("nasa_id", nextItem.nasa_id);
      console.log("localStorage nasa_id", nextItem.nasa_id);

      // console.log("e.target", e.target);
      // console.log("showCardContainer", showCardContainer);
      displayCard.renderCard(nextItem);
    }
  }
  //if boolean isn't true then grab state from nasaClient and add it
}

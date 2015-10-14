/**
* Generated On: 2015-10-5
* Class: Quadtree
* Description: Structure de données spatiales possedant jusqu'à 4 Nodes
*/

/**
 * 
 * @param {type} Layer
 * @param {type} BoudingBox
 * @returns {Quadtree_L10.Quadtree}
 */
define('Scene/Quadtree',['Scene/Layer','Scene/BoudingBox'], function(Layer,BoudingBox){

    function Quadtree(tileType,schemeTile){
        
        Layer.call( this);
    
        this.schemeTile       = schemeTile;
        this.tileType         = tileType;
       
        for (var i = 0; i < this.schemeTile.rootCount(); i++)                           
            this.add(this.createTile(this.schemeTile.getRoot(i),0,0,i));                   
                        
    }
    
    Quadtree.prototype = Object.create( Layer.prototype );

    Quadtree.prototype.constructor = Quadtree;
    
    Quadtree.prototype.getMesh = function(){
               
        return this.children;
    };
    
    Quadtree.prototype.northWest = function(node)
    {
        return node.children[0];
    };
    
    Quadtree.prototype.northEast = function(node)
    {
        return node.children[1];
    };
    
    Quadtree.prototype.southWest = function(node)
    {
        return node.children[2];
    };
    
    Quadtree.prototype.southEast = function(node)
    {
        return node.children[3];
    };    
    
    Quadtree.prototype.createTile = function(bbox,zoom,x,y)
    {
        var tile = new this.tileType(bbox);
        tile.position.set(tile.bbox.center.x,tile.bbox.center.y,0);        
        tile.level = zoom;
        this.interCommand.getTile(zoom,x,y).then(function(texture)
        {   
            this.setTexture(texture);
            

        }.bind(tile)); 
        
        return tile;
    };    
    
    
   /**
    * return 4 equals subdivisions of the bouding box
    * @param {type} node
    * @returns {Array} four bounding box
    */
    Quadtree.prototype.subdivide = function(node)
    {
        var subdiv = [];
        
        var bbox = node.bbox;
        
        subdiv.push(new BoudingBox(bbox.minLongitude,bbox.center.x,bbox.center.y,bbox.maxLatitude));
        subdiv.push(new BoudingBox(bbox.center.x,bbox.maxLongitude,bbox.center.y,bbox.maxLatitude));
        subdiv.push(new BoudingBox(bbox.minLongitude,bbox.center.x,bbox.minLatitude,bbox.center.y));
        subdiv.push(new BoudingBox(bbox.center.x,bbox.maxLongitude,bbox.minLatitude,bbox.center.y));        
        
        node.subdivise(subdiv);
        
        
    };
   
    return Quadtree;

});